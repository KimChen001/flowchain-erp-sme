// The supplier reply outcome export (docs/supplier-reply-dates-design.md §4.12,
// step 2): one row per reply, and the promise revisions in the same window
// with where each came from, so the reliability measure can be checked by
// hand. People with settings.export.read download it from Settings.
//
// What leaves the server follows DD-7 (docs/drafted-decisions-design.md):
// codes, ids and dates everywhere. The reply text, the decision note, the
// supplier's name and a revision's reason (which quotes the reply) only on a
// public-data workspace (UCI or M5), where the replies are written by us.
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { publicDataNoteSummary } from '../domain/public-data-note.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'

export const SUPPLIER_REPLY_EXPORT_PERMISSION = 'settings.export.read'
// Rows per sheet, as the other data exports (pilot-operations-service.mjs).
export const SUPPLIER_REPLY_EXPORT_LIMIT = 5000
// The default window ends today and spans this many days; a window may span
// at most a year.
export const SUPPLIER_REPLY_EXPORT_DEFAULT_DAYS = 90
const MAX_WINDOW_DAYS = 366
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const isoDay = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null)
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS
const addDays = (day, days) => new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10)

export class SupplierReplyExportError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SupplierReplyExportError'
    this.code = code
    this.status = status
  }
}
const fail = (code, message, status) => { throw new SupplierReplyExportError(code, message, status) }

// The window as days in the workspace's timezone: both ends included.
export function supplierReplyExportWindow({ from, to } = {}, today) {
  const end = text(to) || today
  const start = text(from) || addDays(end, -(SUPPLIER_REPLY_EXPORT_DEFAULT_DAYS - 1))
  for (const [field, value] of [['from', start], ['to', end]]) {
    if (!ISO_DAY.test(value) || isoDay(new Date(`${value}T00:00:00Z`)) !== value) fail('SUPPLIER_REPLY_EXPORT_DAY_INVALID', `Enter ${field} as a calendar date (YYYY-MM-DD).`, 422)
  }
  if (start > end) fail('SUPPLIER_REPLY_EXPORT_WINDOW_INVALID', 'The start date is after the end date.', 422)
  if (dayNumber(end) - dayNumber(start) + 1 > MAX_WINDOW_DAYS) fail('SUPPLIER_REPLY_EXPORT_WINDOW_TOO_LONG', `Choose a window of at most ${MAX_WINDOW_DAYS} days.`, 422)
  return { from: start, to: end }
}

// What became of a reply, as §4.12 counts it.
export function supplierReplyOutcome(row) {
  if (row.state === 'recorded') return Number(row.editedLines) > 0 ? 'recorded_edited' : 'recorded_unchanged'
  if (row.state === 'not_recorded') return row.reasonCode ? `not_recorded_${row.reasonCode}` : 'not_recorded'
  return text(row.state) || null
}

// Each line of the stored check as ref:outcome, with the issue after a slash
// when it was not proposed ("L1:proposed; L2:needs_you/date_mismatch").
export function supplierReplyLineOutcomes(check) {
  return array(check?.lines).map((line) => `${line.ref || '-'}:${line.outcome}${line.issue ? `/${line.issue}` : ''}`).join('; ')
}
// The dates the check proposed or confirmed ("L1:2026-11-27").
export function supplierReplyProposedDates(check) {
  return array(check?.lines).filter((line) => line.proposedDate).map((line) => `${line.ref || '-'}:${line.proposedDate}`).join('; ')
}

const minutesBetween = (start, end) => {
  const from = start ? new Date(start).getTime() : NaN
  const until = end ? new Date(end).getTime() : NaN
  return Number.isFinite(from) && Number.isFinite(until) ? Math.round((until - from) / 60_000) : null
}

// The two sheets' rows, from the rows read. Column names are stable codes,
// the same in every interface language, so a script reads any export.
//   replies   SupplierReply rows
//   orders    Map of purchase order id -> { number, supplierId }
//   suppliers Map of supplier id -> { code, name }
//   revisions PurchaseOrderPromiseRevision rows, each with sku
//   replyOfRevision Map of revision id -> reply id
//   includeText  the workspace is a public-data one (DD-7)
export function supplierReplyExportRows({ replies = [], orders = new Map(), suppliers = new Map(), revisions = [], replyOfRevision = new Map(), includeText = false, timeZone } = {}) {
  const textOnly = (pairs) => (includeText ? pairs : [])
  const replyRows = replies.map((row) => {
    const order = orders.get(row.purchaseOrderId) || {}
    const supplierId = row.supplierId || order.supplierId || null
    const supplier = suppliers.get(supplierId) || {}
    const usage = row.usage && typeof row.usage === 'object' ? row.usage : {}
    const revisionIds = array(row.revisionIds)
    return Object.fromEntries([
      ['reply_id', row.id],
      ['order_number', order.number || null],
      ['order_id', row.purchaseOrderId],
      ['supplier_id', supplierId],
      ['supplier_code', supplier.code || null],
      ...textOnly([['supplier_name', supplier.name || order.supplierName || null]]),
      ['received_on', row.receivedOn],
      ['pasted_at', new Date(row.createdAt).toISOString()],
      ['source', row.source],
      ['reading_status', row.readingStatus],
      ['state', row.state],
      ['outcome', supplierReplyOutcome(row)],
      ['reply_kind', row.check?.replyKind ?? null],
      ['line_outcomes', supplierReplyLineOutcomes(row.check)],
      ['proposed_dates', supplierReplyProposedDates(row.check)],
      ['flags', array(row.check?.flags).map((flag) => flag.kind).join('; ')],
      ['instructions_ignored', Boolean(row.instructionsIgnored)],
      ['quoted_text_hidden', Boolean(row.quotedTextHidden)],
      ['decision', row.decision || null],
      ['reason_code', row.reasonCode || null],
      ['lines_edited', row.decision === 'recorded' ? Number(row.editedLines) || 0 : null],
      ['revision_ids', revisionIds.join('; ')],
      ['decided_by_id', row.decidedById || null],
      ['decided_at', row.decidedAt ? new Date(row.decidedAt).toISOString() : null],
      ['minutes_to_decision', minutesBetween(row.createdAt, row.decidedAt)],
      ['superseded_by_id', row.supersededById || null],
      ['provider', row.provider || null],
      ['model', row.model || null],
      ['prompt_version', row.promptVersion || null],
      ['calls', Number.isFinite(Number(usage.calls)) ? Number(usage.calls) : null],
      ['input_tokens', Number.isFinite(Number(usage.inputTokens)) ? Number(usage.inputTokens) : null],
      ['output_tokens', Number.isFinite(Number(usage.outputTokens)) ? Number(usage.outputTokens) : null],
      ...textOnly([['reply_text', row.text || null], ['decision_note', row.note || null]]),
    ])
  })
  const revisionRows = revisions.map((row) => {
    const order = orders.get(row.purchaseOrderId) || {}
    const previous = isoDay(row.previousDate)
    const next = isoDay(row.newDate)
    return Object.fromEntries([
      ['revision_id', row.id],
      ['order_number', order.number || null],
      ['order_id', row.purchaseOrderId],
      ['line_id', row.purchaseOrderLineId],
      ['sku', row.sku || null],
      ['previous_date', previous],
      ['new_date', next],
      ['days_moved', previous && next ? dayNumber(next) - dayNumber(previous) : null],
      ['source', row.source === 'supplier_reply' ? 'supplier_reply' : 'manual'],
      ['reply_id', replyOfRevision.get(row.id) || null],
      ['revised_on', tenantCalendarDay(new Date(row.createdAt), timeZone)],
      ['revised_at', new Date(row.createdAt).toISOString()],
      ['actor_id', row.actorId || null],
      ...textOnly([['reason', row.reason || null]]),
    ])
  })
  return { replies: replyRows, revisions: revisionRows }
}

// resolveActor: the provisioned actor of the request (tests give their own).
export function createSupplierReplyExportService({ prisma, now = () => new Date(), resolveActor = resolveProvisionedActor } = {}) {
  if (!prisma) throw new Error('Prisma client is required for the supplier reply export.')

  async function exportOutcomes(query, identity) {
    const actor = await resolveActor(prisma, identity)
    assertAuthorized({ actor, permission: SUPPLIER_REPLY_EXPORT_PERMISSION, tenantId: actor.tenantId })
    const tenantId = actor.tenantId
    const [tenant, note] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      prisma.runtimeRecord.findUnique({ where: { tenantId_namespace_recordKey: { tenantId, namespace: 'workspace.public-data', recordKey: 'note' } }, select: { payload: true } }),
    ])
    const timeZone = tenant?.timezone || undefined
    const window = supplierReplyExportWindow(query, tenantCalendarDay(now(), timeZone))
    const publicData = publicDataNoteSummary(note?.payload)?.dataset || null
    const includeText = Boolean(publicData)

    // Replies by the day they were received; revisions by the workspace day
    // they were made, read with a day's margin each side and then cut.
    const [replies, revisionsRead] = await Promise.all([
      prisma.supplierReply.findMany({
        where: { tenantId, receivedOn: { gte: window.from, lte: window.to } },
        orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: SUPPLIER_REPLY_EXPORT_LIMIT + 1,
        select: {
          id: true, purchaseOrderId: true, supplierId: true, source: true, receivedOn: true, createdAt: true, state: true, readingStatus: true,
          provider: true, model: true, promptVersion: true, check: true, usage: true, instructionsIgnored: true, quotedTextHidden: true,
          decision: true, reasonCode: true, decidedById: true, decidedAt: true, editedLines: true, revisionIds: true, supersededById: true,
          ...(includeText ? { text: true, note: true } : {}),
        },
      }),
      prisma.purchaseOrderPromiseRevision.findMany({
        where: { tenantId, createdAt: { gte: new Date(`${addDays(window.from, -1)}T00:00:00Z`), lt: new Date(`${addDays(window.to, 2)}T00:00:00Z`) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SUPPLIER_REPLY_EXPORT_LIMIT * 2,
        select: { id: true, purchaseOrderId: true, purchaseOrderLineId: true, previousDate: true, newDate: true, source: true, actorId: true, createdAt: true, ...(includeText ? { reason: true } : {}) },
      }),
    ])
    const inWindow = revisionsRead.filter((row) => {
      const day = tenantCalendarDay(new Date(row.createdAt), timeZone)
      return day >= window.from && day <= window.to
    })
    const replyRows = replies.slice(0, SUPPLIER_REPLY_EXPORT_LIMIT)
    const revisionRows = inWindow.slice(0, SUPPLIER_REPLY_EXPORT_LIMIT)
    const truncated = replies.length > SUPPLIER_REPLY_EXPORT_LIMIT || inWindow.length > SUPPLIER_REPLY_EXPORT_LIMIT || revisionsRead.length >= SUPPLIER_REPLY_EXPORT_LIMIT * 2

    const orderIds = [...new Set([...replyRows, ...revisionRows].map((row) => row.purchaseOrderId))]
    const lineIds = [...new Set(revisionRows.map((row) => row.purchaseOrderLineId))]
    // The reply a revision came from, whatever day the reply was received.
    const fromReplies = revisionRows.some((row) => row.source === 'supplier_reply')
    const [orders, lines, recorded] = await Promise.all([
      orderIds.length ? prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, number: true, supplierId: true, ...(includeText ? { supplierName: true } : {}) } }) : [],
      lineIds.length ? prisma.purchaseOrderLine.findMany({ where: { id: { in: lineIds }, purchaseOrder: { tenantId } }, select: { id: true, sku: true } }) : [],
      fromReplies ? prisma.supplierReply.findMany({ where: { tenantId, state: 'recorded' }, select: { id: true, revisionIds: true } }) : [],
    ])
    const orderMap = new Map(orders.map((row) => [row.id, row]))
    const supplierIds = [...new Set([...replyRows.map((row) => row.supplierId), ...orders.map((row) => row.supplierId)].filter(Boolean))]
    const supplierRows = supplierIds.length ? await prisma.supplier.findMany({ where: { tenantId, id: { in: supplierIds } }, select: { id: true, code: true, ...(includeText ? { name: true } : {}) } }) : []
    const skuOf = new Map(lines.map((row) => [row.id, row.sku]))
    const replyOfRevision = new Map(recorded.flatMap((row) => array(row.revisionIds).map((revisionId) => [revisionId, row.id])))
    const rows = supplierReplyExportRows({
      replies: replyRows,
      orders: orderMap,
      suppliers: new Map(supplierRows.map((row) => [row.id, row])),
      revisions: revisionRows.map((row) => ({ ...row, sku: skuOf.get(row.purchaseOrderLineId) || null })),
      replyOfRevision,
      includeText,
      timeZone,
    })
    return {
      generatedAt: now().toISOString(),
      window,
      timeZone: timeZone || null,
      publicData,
      textIncluded: includeText,
      truncated,
      limit: SUPPLIER_REPLY_EXPORT_LIMIT,
      ...rows,
    }
  }
  return { exportOutcomes }
}
