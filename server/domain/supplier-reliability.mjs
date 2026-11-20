import { SUPPLIER_RELIABILITY_CONTRACT_VERSION, SUPPLIER_RELIABILITY_RULES } from '../../shared/supplier-reliability-contract.mjs'
import { SUPPLIER_REPLY_DISMISS_REASONS } from '../../shared/supplier-reply-contract.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { currentPromisedDay, promiseDay } from './purchase-order-promise-dates.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { supplierReplyOutcome, supplierReplyRecordedDates } from './supplier-reply-outcome.mjs'
import { daysBetween, localDay, scorecardParameters, scorecardPurchaseOrderStanding } from './supplier-scorecard.mjs'

// Supplier reliability (docs/supplier-reply-dates-design.md §4.12, SR-7):
// per supplier, how often its promised dates move and how it answers a chase.
// The figures and their rules are in shared/supplier-reliability-contract.mjs.
//
// A measure beside on time, never part of it: the scorecard keeps measuring
// against the original promise, and nothing here is read by it.
//
// Every figure follows purchase order read access, as the supplier list's
// order columns do (supplier-insights.mjs): the revisions are changes to
// purchase order lines, and a reply is read where its order is.

const text = (value) => String(value ?? '').trim()
const HOUR = 3_600_000
const round1 = (value) => Math.round(value * 10) / 10
const round2 = (value) => Math.round(value * 100) / 100
const { minimumSample } = SUPPLIER_RELIABILITY_RULES
// A share of `of`, null under the minimum sample (the page shows the counts).
const shareOf = (count, of) => ({ count, of, share: of >= minimumSample && of > 0 ? count / of : null })
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// The day a line is dated by, as the scorecard dates it: its original
// promise, else its current date.
const lineDay = (line, purchaseOrder) => promiseDay(line.originalPromisedDate) || currentPromisedDay(line, purchaseOrder)

// A revision is a change: a row with a previous date and a different day. A
// row without a previous date is the line's first promise.
function revisionDays(row) {
  const previous = promiseDay(row.previousDate)
  const next = promiseDay(row.newDate)
  if (!previous || !next || previous === next) return null
  return daysBetween(previous, next)
}

// Date revisions per supplier, on the orders the scorecard measures with a
// line dated in the window.
export function supplierRevisionFigures({ purchaseOrders = [], revisions = [], window }) {
  const moved = new Map()
  for (const row of revisions) {
    const days = revisionDays(row)
    if (days === null) continue
    const id = text(row.purchaseOrderId)
    moved.set(id, [...(moved.get(id) || []), days])
  }
  const bySupplier = new Map()
  for (const purchaseOrder of purchaseOrders) {
    const supplierId = text(purchaseOrder.supplierId)
    if (!supplierId || scorecardPurchaseOrderStanding(purchaseOrder) !== 'measured') continue
    const inWindow = (purchaseOrder.lines || []).some((line) => {
      const day = lineDay(line, purchaseOrder)
      return Boolean(day) && day >= window.from && day <= window.to
    })
    if (!inWindow) continue
    const row = bySupplier.get(supplierId) || { orders: 0, revisedOrders: 0, days: [] }
    const days = moved.get(text(purchaseOrder.id)) || []
    row.orders += 1
    if (days.length) row.revisedOrders += 1
    row.days.push(...days)
    bySupplier.set(supplierId, row)
  }
  return bySupplier
}

function revisionsOf(row) {
  const days = row?.days || []
  const orders = row?.orders || 0
  return {
    orders,
    revisedOrders: row?.revisedOrders || 0,
    revisions: days.length,
    perOrder: orders >= minimumSample ? round2(days.length / orders) : null,
    averageDaysMoved: days.length >= minimumSample ? round1(days.reduce((sum, value) => sum + value, 0) / days.length) : null,
    movedLater: shareOf(days.filter((value) => value > 0).length, days.length),
  }
}

// The contract's bucket for one reply, from the outcome the export uses too
// (supplier-reply-outcome.mjs): unchanged or edited judged on the proposed
// lines against the dates the reply's revisions wrote, manual when nothing
// was proposed. { bucket, reason } with reason for a dismissal; null for a
// superseded paste. recordedDates: the reply's revisions' dates by line.
const BUCKETS = Object.freeze({
  recorded_unchanged: 'recordedUnchanged', recorded_edited: 'recordedEdited', recorded_manual: 'recordedManual',
  // Recorded with its dates unknown (no revisions found for it): the read
  // looks them up by revisionIds and by the audit rows' origin first, so it
  // should not happen. When it does it is not counted as unchanged.
  recorded: 'recordedEdited',
  needs_you: 'needsYou', proposed: 'proposed', nothing_to_record: 'nothingToRecord',
})
export function supplierReliabilityBucket(reply, recordedDates = null) {
  const outcome = supplierReplyOutcome(reply, { recordedDates })
  if (text(outcome).startsWith('not_recorded')) {
    const reason = text(outcome).slice('not_recorded_'.length)
    return { bucket: 'notRecorded', reason: SUPPLIER_REPLY_DISMISS_REASONS.includes(reason) ? reason : 'other' }
  }
  return BUCKETS[outcome] ? { bucket: BUCKETS[outcome] } : null
}

// A read reply with a stated date: at least one line passed the checks with
// a day, a proposal or the current date confirmed.
const hasStatedDate = (reply) => (Array.isArray(reply.check?.lines) ? reply.check.lines : []).some((line) => line?.outcome === 'proposed' || line?.outcome === 'confirmed')
const instant = (value) => (value instanceof Date ? value.getTime() : Date.parse(text(value)))

// Reply figures per supplier. replies: SupplierReply rows received in the
// window, superseded ones already left out; supplierId from the reply, else
// its order. recordedDates: by reply id, the dates its revisions wrote by
// line (supplierReplyRecordedDates).
export function supplierReplyFigures({ replies = [], recordedDates = new Map() }) {
  const bySupplier = new Map()
  for (const reply of replies) {
    const supplierId = text(reply.supplierId) || text(reply.purchaseOrder?.supplierId)
    const outcome = supplierReliabilityBucket(reply, recordedDates.get(text(reply.id)) || null)
    if (!supplierId || !outcome) continue
    const row = bySupplier.get(supplierId) || { received: 0, read: 0, stated: 0, outcomes: emptyOutcomes(), hours: [] }
    row.received += 1
    if (text(reply.readingStatus) === 'read') {
      row.read += 1
      if (hasStatedDate(reply)) row.stated += 1
    }
    if (outcome.bucket === 'notRecorded') row.outcomes.notRecorded[outcome.reason] += 1
    else row.outcomes[outcome.bucket] += 1
    if (text(reply.state) === 'recorded') {
      const hours = (instant(reply.decidedAt) - instant(reply.createdAt)) / HOUR
      row.hours.push(Number.isFinite(hours) ? Math.max(0, hours) : null)
    }
    bySupplier.set(supplierId, row)
  }
  return bySupplier
}

function emptyOutcomes() {
  return { recordedUnchanged: 0, recordedEdited: 0, recordedManual: 0, notRecorded: Object.fromEntries(SUPPLIER_REPLY_DISMISS_REASONS.map((reason) => [reason, 0])), needsYou: 0, proposed: 0, nothingToRecord: 0 }
}

function repliesOf(row) {
  const hours = (row?.hours || []).filter((value) => value !== null)
  return {
    received: row?.received || 0,
    read: row?.read || 0,
    withStatedDate: shareOf(row?.stated || 0, row?.read || 0),
    outcomes: row?.outcomes || emptyOutcomes(),
    recorded: row?.hours?.length || 0,
    medianHoursToRecord: hours.length >= minimumSample ? round1(median(hours)) : null,
  }
}

// The response for every supplier, from rows already read for one tenant.
// replyRevisions: the promise revisions recorded replies wrote, each with
// the reply's id (replyId), for their dates.
export function buildSupplierReliability({ suppliers = [], purchaseOrders = [], revisions = [], replies = [], replyRevisions = [], window, asOf, visibility }) {
  const revisionRows = visibility.revisions ? supplierRevisionFigures({ purchaseOrders, revisions, window }) : new Map()
  const byReply = new Map()
  for (const row of replyRevisions) byReply.set(text(row.replyId), [...(byReply.get(text(row.replyId)) || []), row])
  const recordedDates = new Map([...byReply].map(([id, rows]) => [id, supplierReplyRecordedDates(rows)]))
  const replyRows = visibility.replies ? supplierReplyFigures({ replies, recordedDates }) : new Map()
  return {
    contractVersion: SUPPLIER_RELIABILITY_CONTRACT_VERSION,
    asOf,
    window: { from: window.from, to: window.to, days: daysBetween(window.from, window.to) + 1 },
    minimumSample,
    visibility,
    suppliers: Object.fromEntries(suppliers.map((supplier) => [supplier.id, {
      revisions: visibility.revisions ? revisionsOf(revisionRows.get(supplier.id)) : null,
      replies: visibility.replies ? repliesOf(replyRows.get(supplier.id)) : null,
    }])),
  }
}

const UNMEASURED_STATUSES = ['draft', 'pending_approval', 'rejected', 'cancelled']
const array = (value) => (Array.isArray(value) ? value : [])

// The promise revisions each recorded reply wrote, with its id: by the
// reply's revisionIds, else by the revision audit rows whose origin is the
// reply (as the service finds a record already written).
async function recordedReplyRevisions(prisma, tenantId, replies) {
  const recorded = replies.filter((reply) => text(reply.state) === 'recorded')
  if (!recorded.length) return []
  const owner = new Map()
  for (const reply of recorded) for (const id of array(reply.revisionIds).map(text).filter(Boolean)) owner.set(id, text(reply.id))
  const unknown = recorded.filter((reply) => !array(reply.revisionIds).length).map((reply) => text(reply.id))
  if (unknown.length) {
    const rows = await prisma.auditLog.findMany({ where: { tenantId, action: 'purchase_order_promise_revised', OR: unknown.map((id) => ({ metadata: { path: ['origin', 'id'], equals: id } })) }, select: { metadata: true } })
    for (const row of array(rows)) if (text(row.metadata?.revisionId)) owner.set(text(row.metadata.revisionId), text(row.metadata?.origin?.id))
  }
  if (!owner.size) return []
  const rows = await prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId, id: { in: [...owner.keys()] } }, select: { id: true, purchaseOrderLineId: true, newDate: true, createdAt: true } })
  return array(rows).map((row) => ({ ...row, replyId: owner.get(text(row.id)) }))
}

export function createSupplierReliabilityReadService({ prisma, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('prisma is required')
  return {
    async read(context = {}) {
      const actor = context.actor || await resolveProvisionedActor(prisma, context.identity || context)
      const tenantId = actor.tenantId
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
      const asOf = localDay(now(), text(tenant?.timezone) || 'America/New_York')
      // The scorecard's default period: the 90 days ending today.
      const { period: window } = scorecardParameters({}, asOf)
      const orders = Boolean(reportReadAccessFor(actor).collections.purchaseOrders)
      const visibility = { revisions: orders, replies: orders }
      const [suppliers, purchaseOrders, replies] = await Promise.all([
        prisma.supplier.findMany({ where: { tenantId }, select: { id: true }, orderBy: [{ id: 'asc' }] }),
        orders
          ? prisma.purchaseOrder.findMany({
            where: { tenantId, supplierId: { not: null }, status: { notIn: UNMEASURED_STATUSES } },
            select: { id: true, supplierId: true, status: true, expectedDate: true, issuedAt: true, metadata: true, lines: { select: { id: true, originalPromisedDate: true, metadata: true, receivedQuantity: true } } },
            orderBy: [{ id: 'asc' }],
          })
          : [],
        orders
          ? prisma.supplierReply.findMany({
            where: { tenantId, receivedOn: { gte: window.from, lte: window.to }, state: { not: 'superseded' } },
            select: { id: true, supplierId: true, state: true, readingStatus: true, check: true, reasonCode: true, revisionIds: true, createdAt: true, decidedAt: true, purchaseOrder: { select: { supplierId: true } } },
          })
          : [],
      ])
      const ids = purchaseOrders.map((row) => row.id)
      const revisions = ids.length
        ? await prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId, purchaseOrderId: { in: ids }, previousDate: { not: null } }, select: { purchaseOrderId: true, previousDate: true, newDate: true } })
        : []
      const replyRevisions = await recordedReplyRevisions(prisma, tenantId, replies)
      return buildSupplierReliability({ suppliers, purchaseOrders, revisions, replies, replyRevisions, window, asOf, visibility })
    },
  }
}
