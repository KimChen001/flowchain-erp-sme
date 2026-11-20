// The supplier reply outcome export (docs/supplier-reply-dates-design.md §4.12,
// step 2): one row per reply, and the promise revisions in the same window
// with where each came from, so the reliability measure can be checked by
// hand. People with settings.export.read and the purchase order read
// permission download it from Settings.
//
// What leaves the server follows DD-7 (docs/drafted-decisions-design.md):
// codes, ids and dates everywhere. The reply text, the decision note, the
// supplier's name and a revision's reason (which quotes the reply) only on a
// public-data workspace (UCI or M5), where the replies are written by us.
// Elsewhere those fields are not read from the database; the stored check and
// usage are read, and only their codes, dates and counts are copied out.
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { publicDataNoteSummary } from '../domain/public-data-note.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { supplierReplyCardState, supplierReplyOutcome, supplierReplyProposedLines, supplierReplyRecordedDates } from '../domain/supplier-reply-outcome.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'

export const SUPPLIER_REPLY_EXPORT_PERMISSION = 'settings.export.read'
// The export carries order numbers, SKUs and, on public data, reply text:
// what someone who reads purchase orders sees.
export const SUPPLIER_REPLY_EXPORT_READ_PERMISSION = 'procurement.purchase_order.read'
// Rows per sheet, as the other data exports (pilot-operations-service.mjs).
export const SUPPLIER_REPLY_EXPORT_LIMIT = 5000
// The default window ends today and spans this many days; a window may span
// at most a year.
export const SUPPLIER_REPLY_EXPORT_DEFAULT_DAYS = 90
const MAX_WINDOW_DAYS = 366
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const REVISED = 'purchase_order_promise_revised'

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

// The first instant of a calendar day in a timezone. Offsets are whole
// quarter hours and at most 14 hours, so the day starts within 14 hours of
// its UTC midnight, on a quarter hour.
export function tenantDayStart(day, timeZone) {
  const midnight = Date.parse(`${day}T00:00:00Z`)
  for (let at = midnight - 14 * 3_600_000; at <= midnight + 14 * 3_600_000; at += 900_000) {
    if (tenantCalendarDay(new Date(at), timeZone) >= day) return new Date(at)
  }
  return new Date(midnight)
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
//   recordedOf Map of reply id -> its revisions ({ purchaseOrderLineId, newDate })
//   includeText  the workspace is a public-data one (DD-7)
export function supplierReplyExportRows({ replies = [], orders = new Map(), suppliers = new Map(), revisions = [], replyOfRevision = new Map(), recordedOf = new Map(), includeText = false, timeZone } = {}) {
  const textOnly = (pairs) => (includeText ? pairs : [])
  const replyRows = replies.map((row) => {
    const order = orders.get(row.purchaseOrderId) || {}
    const supplierId = row.supplierId || order.supplierId || null
    const supplier = suppliers.get(supplierId) || {}
    const usage = row.usage && typeof row.usage === 'object' ? row.usage : {}
    const revisionIds = array(row.revisionIds)
    const written = recordedOf.get(row.id)
    const dates = written ? supplierReplyRecordedDates(written) : null
    // On a recorded reply whose dates are known: proposed lines recorded at
    // another date or left out, and lines recorded that were not proposed.
    const proposed = supplierReplyProposedLines(row.check)
    const known = row.state === 'recorded' && dates?.size
    const proposedIds = new Set(proposed.map((line) => line.purchaseOrderLineId))
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
      ['card_state', supplierReplyCardState(row)],
      ['state', row.state],
      ['outcome', supplierReplyOutcome(row, { recordedDates: dates })],
      ['reply_kind', row.check?.replyKind ?? null],
      ['line_outcomes', supplierReplyLineOutcomes(row.check)],
      ['proposed_dates', supplierReplyProposedDates(row.check)],
      ['flags', array(row.check?.flags).map((flag) => flag.kind).join('; ')],
      ['instructions_ignored', Boolean(row.instructionsIgnored)],
      ['quoted_text_hidden', Boolean(row.quotedTextHidden)],
      ['decision', row.decision || null],
      ['reason_code', row.reasonCode || null],
      ['lines_edited', known ? proposed.filter((line) => dates.get(line.purchaseOrderLineId) !== line.proposedDate).length : null],
      ['lines_by_hand', known ? [...dates.keys()].filter((lineId) => !proposedIds.has(lineId)).length : null],
      ['revision_ids', (revisionIds.length ? revisionIds : array(written).map((revision) => revision.id)).join('; ')],
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

// The "about" sheet: what the export holds and where it stops. Field names
// are codes; the notes are in the reader's interface language (en-US, or
// zh-CN), and the values are the same in both.
const ABOUT_NOTES = {
  when_truncated: [
    (limit) => `A truncated sheet holds the earliest ${limit} rows of the window: replies by received date, revisions by time made. Choose a shorter window for the rest.`,
    (limit) => `被截断的工作表只含期间内最早的 ${limit} 行：回复按收到日期，修改按修改时间。其余部分请缩短期间再导出。`,
  ],
  replies_in_window: [
    () => 'Replies received on a day in the window (received_on), in the workspace timezone.',
    () => '收到日期（received_on）在期间内的回复，按工作区时区计。',
  ],
  revisions_in_window: [
    () => 'Promised-date changes made on a day in the window (revised_on), in the workspace timezone.',
    () => '修改日期（revised_on）在期间内的承诺日期修改，按工作区时区计。',
  ],
  outcome: [
    () => 'recorded_unchanged: every proposed line recorded at its proposed date; recorded_edited: a proposed line recorded at another date or left out; recorded_manual: nothing proposed, dates typed by hand; recorded: dates not known; not_recorded_<reason>; otherwise the state. Rare case: a proposed line whose promised date was already the proposed day when it was recorded writes no revision, so it reads as left out and the reply as recorded_edited.',
    () => 'recorded_unchanged：每条建议行都按建议日期记录；recorded_edited：有建议行按其他日期记录或未记录；recorded_manual：没有建议，日期由人手填；recorded：不知道写入了哪些日期；not_recorded_<原因>；其余为当时的状态。少见情况：记录时某建议行的承诺日期已经是建议日期，不会产生修改记录，该行会被视为未记录，回复记为 recorded_edited。',
  ],
  lines_edited: [
    () => 'On a recorded reply whose dates are known: proposed lines recorded at another date or left out. lines_by_hand: lines recorded that were not proposed.',
    () => '已记录且知道写入日期的回复：按其他日期记录或未记录的建议行数。lines_by_hand：记录了但不是建议的行数。',
  ],
  reply_id_link: [
    () => "A supplier_reply revision's reply_id comes from the reply's revision ids, else from the revision's audit row (its origin); it is empty only when neither has it.",
    () => 'supplier_reply 修改的 reply_id 取自回复保存的修改编号，没有时取自该修改的操作记录（origin）；两处都没有时才为空。',
  ],
  text_rule: [
    (included) => (included ? 'Public-data workspace: reply text, decision notes, supplier names and revision reasons are included (DD-7).' : 'Codes, ids and dates only: reply text, decision notes, supplier names and revision reasons are left out (DD-7).'),
    (included) => (included ? '公开数据工作区：包含回复原文、处理备注、供应商名称和修改原因（DD-7）。' : '只含代码、编号和日期：不含回复原文、处理备注、供应商名称和修改原因（DD-7）。'),
  ],
}

export function supplierReplyExportAbout({ generatedAt, window, timeZone, publicData, includeText, replies, revisions, truncated, language = 'en-US' }) {
  const limit = SUPPLIER_REPLY_EXPORT_LIMIT
  const note = (field, value) => [field, ABOUT_NOTES[field][language === 'zh-CN' ? 1 : 0](value)]
  return [
    ['as_of', generatedAt],
    ['window_from', window.from],
    ['window_to', window.to],
    ['time_zone', timeZone || null],
    ['public_data', publicData || 'no'],
    ['text_included', includeText],
    ['limit_per_sheet', limit],
    ['replies_rows', replies],
    ['replies_truncated', truncated.replies],
    ['revisions_rows', revisions],
    ['revisions_truncated', truncated.revisions],
    note('when_truncated', limit),
    note('replies_in_window'),
    note('revisions_in_window'),
    note('outcome'),
    note('lines_edited'),
    note('reply_id_link'),
    note('text_rule', includeText),
  ].map(([field, value]) => ({ field, value }))
}

// resolveActor: the provisioned actor of the request (tests give their own).
export function createSupplierReplyExportService({ prisma, now = () => new Date(), resolveActor = resolveProvisionedActor } = {}) {
  if (!prisma) throw new Error('Prisma client is required for the supplier reply export.')

  // revision id -> reply id, from the audit rows of revisions made from a
  // reply (metadata.origin), for links the reply's revisionIds lack.
  async function originsOf(tenantId, where) {
    const rows = await prisma.auditLog.findMany({ where: { tenantId, action: REVISED, entityType: 'PurchaseOrderLine', ...where }, select: { metadata: true } })
    return rows.flatMap((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
      return metadata.origin?.type === 'supplier_reply' && text(metadata.revisionId) && text(metadata.origin?.id) ? [[text(metadata.revisionId), text(metadata.origin.id)]] : []
    })
  }

  async function exportOutcomes(query, identity) {
    const actor = await resolveActor(prisma, identity)
    for (const permission of [SUPPLIER_REPLY_EXPORT_PERMISSION, SUPPLIER_REPLY_EXPORT_READ_PERMISSION]) assertAuthorized({ actor, permission, tenantId: actor.tenantId })
    const tenantId = actor.tenantId
    const [tenant, note] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      prisma.runtimeRecord.findUnique({ where: { tenantId_namespace_recordKey: { tenantId, namespace: 'workspace.public-data', recordKey: 'note' } }, select: { payload: true } }),
    ])
    const timeZone = tenant?.timezone || undefined
    const generatedAt = now().toISOString()
    const window = supplierReplyExportWindow(query, tenantCalendarDay(now(), timeZone))
    const publicData = publicDataNoteSummary(note?.payload)?.dataset || null
    const includeText = Boolean(publicData)

    // Replies by the day they were received; revisions by the instant they
    // were made, between the window's first and last workspace days. Each
    // reads one row past the limit, to tell a full sheet from a cut one.
    const [replies, revisionsRead] = await Promise.all([
      prisma.supplierReply.findMany({
        where: { tenantId, receivedOn: { gte: window.from, lte: window.to } },
        orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: SUPPLIER_REPLY_EXPORT_LIMIT + 1,
        select: {
          id: true, purchaseOrderId: true, supplierId: true, source: true, receivedOn: true, createdAt: true, state: true, readingStatus: true,
          provider: true, model: true, promptVersion: true, check: true, usage: true, instructionsIgnored: true, quotedTextHidden: true,
          decision: true, reasonCode: true, decidedById: true, decidedAt: true, revisionIds: true, supersededById: true,
          ...(includeText ? { text: true, note: true } : {}),
        },
      }),
      prisma.purchaseOrderPromiseRevision.findMany({
        where: { tenantId, createdAt: { gte: tenantDayStart(window.from, timeZone), lt: tenantDayStart(addDays(window.to, 1), timeZone) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SUPPLIER_REPLY_EXPORT_LIMIT + 1,
        select: { id: true, purchaseOrderId: true, purchaseOrderLineId: true, previousDate: true, newDate: true, source: true, actorId: true, createdAt: true, ...(includeText ? { reason: true } : {}) },
      }),
    ])
    const replyRows = replies.slice(0, SUPPLIER_REPLY_EXPORT_LIMIT)
    const revisionRows = revisionsRead.slice(0, SUPPLIER_REPLY_EXPORT_LIMIT)
    const truncated = { replies: replies.length > SUPPLIER_REPLY_EXPORT_LIMIT, revisions: revisionsRead.length > SUPPLIER_REPLY_EXPORT_LIMIT }

    // The dates each recorded reply wrote, for its outcome: its revisions,
    // found by its revision ids or, when those were not saved, by the audit
    // rows that name it as their origin.
    const recordedReplies = replyRows.filter((row) => row.state === 'recorded')
    const unsaved = recordedReplies.filter((row) => !array(row.revisionIds).length).map((row) => row.id)
    const fromAudit = unsaved.length ? await originsOf(tenantId, { OR: unsaved.map((id) => ({ metadata: { path: ['origin', 'id'], equals: id } })) }) : []
    const writtenIds = [...new Set([...recordedReplies.flatMap((row) => array(row.revisionIds)), ...fromAudit.map(([revisionId]) => revisionId)])]
    // Every link a recorded reply holds, whatever day it was received.
    const fromReplies = revisionRows.some((row) => row.source === 'supplier_reply')
    const [written, recordedLinks] = await Promise.all([
      writtenIds.length ? prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId, id: { in: writtenIds } }, select: { id: true, purchaseOrderLineId: true, newDate: true, createdAt: true } }) : [],
      fromReplies ? prisma.supplierReply.findMany({ where: { tenantId, state: 'recorded' }, select: { id: true, revisionIds: true } }) : [],
    ])
    const replyOfRevision = new Map([...recordedLinks.flatMap((row) => array(row.revisionIds).map((revisionId) => [revisionId, row.id])), ...fromAudit])
    // A revision made from a reply whose ids were not saved: its audit row.
    const unlinked = revisionRows.filter((row) => row.source === 'supplier_reply' && !replyOfRevision.has(row.id))
    if (unlinked.length) {
      const times = unlinked.map((row) => new Date(row.createdAt).getTime())
      const found = await originsOf(tenantId, { entityId: { in: [...new Set(unlinked.map((row) => row.purchaseOrderLineId))] }, createdAt: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } })
      for (const [revisionId, replyId] of found) if (!replyOfRevision.has(revisionId)) replyOfRevision.set(revisionId, replyId)
    }
    const revisionsById = new Map(written.map((row) => [row.id, row]))
    const replyOfWritten = new Map([...recordedReplies.flatMap((row) => array(row.revisionIds).map((revisionId) => [revisionId, row.id])), ...fromAudit])
    const recordedOf = new Map()
    for (const [revisionId, replyId] of replyOfWritten) {
      const revision = revisionsById.get(revisionId)
      if (revision) recordedOf.set(replyId, [...(recordedOf.get(replyId) || []), revision])
    }

    const orderIds = [...new Set([...replyRows, ...revisionRows].map((row) => row.purchaseOrderId))]
    const lineIds = [...new Set(revisionRows.map((row) => row.purchaseOrderLineId))]
    const [orders, lines] = await Promise.all([
      orderIds.length ? prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, number: true, supplierId: true, ...(includeText ? { supplierName: true } : {}) } }) : [],
      lineIds.length ? prisma.purchaseOrderLine.findMany({ where: { id: { in: lineIds }, purchaseOrder: { tenantId } }, select: { id: true, sku: true } }) : [],
    ])
    const supplierIds = [...new Set([...replyRows.map((row) => row.supplierId), ...orders.map((row) => row.supplierId)].filter(Boolean))]
    const supplierRows = supplierIds.length ? await prisma.supplier.findMany({ where: { tenantId, id: { in: supplierIds } }, select: { id: true, code: true, ...(includeText ? { name: true } : {}) } }) : []
    const skuOf = new Map(lines.map((row) => [row.id, row.sku]))
    const rows = supplierReplyExportRows({
      replies: replyRows,
      orders: new Map(orders.map((row) => [row.id, row])),
      suppliers: new Map(supplierRows.map((row) => [row.id, row])),
      revisions: revisionRows.map((row) => ({ ...row, sku: skuOf.get(row.purchaseOrderLineId) || null })),
      replyOfRevision,
      recordedOf,
      includeText,
      timeZone,
    })
    return {
      generatedAt,
      window,
      timeZone: timeZone || null,
      publicData,
      textIncluded: includeText,
      truncated,
      limit: SUPPLIER_REPLY_EXPORT_LIMIT,
      about: supplierReplyExportAbout({ generatedAt, window, timeZone, publicData, includeText, replies: rows.replies.length, revisions: rows.revisions.length, truncated, language: query?.language === 'zh-CN' ? 'zh-CN' : 'en-US' }),
      ...rows,
    }
  }
  return { exportOutcomes }
}
