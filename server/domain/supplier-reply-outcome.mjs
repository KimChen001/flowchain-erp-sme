// What became of a supplier reply (docs/supplier-reply-dates-design.md §4.12),
// in one place, so the outcome export and the supplier evaluation page's
// reliability measure count the same way.
//
//   recorded_unchanged       every proposed line was recorded at its proposed date
//   recorded_edited          at least one proposed line was recorded at another
//                            date, or left out
//   recorded_manual          nothing was proposed (AI off, a failed reading, or
//                            every line left for the person) and the person
//                            typed the dates
//   recorded                 recorded, but the dates it wrote are not known
//   not_recorded_<reason>    dismissed with that reason (wrong_reading,
//                            supplier_will_confirm, other)
//   proposed, needs_you, nothing_to_record, superseded   the state as it is
//
// Lines the person filled in by hand next to a proposal (lines left for them)
// are not edits: only a proposed line recorded at another date, or dropped,
// makes a reply edited. The dates a record wrote are not kept on the reply;
// they are its promise revisions (SupplierReply.revisionIds, or the audit
// rows whose metadata.origin is the reply).

const array = (value) => (Array.isArray(value) ? value : [])
const day = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null
}

// The lines a reply's card proposed: { purchaseOrderLineId, proposedDate }.
export function supplierReplyProposedLines(check) {
  return array(check?.lines).filter((line) => line.outcome === 'proposed' && line.purchaseOrderLineId && line.proposedDate)
}

// The date each line was recorded at, from the reply's promise revisions
// ({ purchaseOrderLineId, newDate }; newDate a Date or YYYY-MM-DD). The later
// revision of a line wins.
export function supplierReplyRecordedDates(revisions) {
  const sorted = [...array(revisions)].sort((a, b) => String(a.createdAt ? new Date(a.createdAt).toISOString() : '').localeCompare(String(b.createdAt ? new Date(b.createdAt).toISOString() : '')))
  return new Map(sorted.filter((row) => row?.purchaseOrderLineId && day(row.newDate)).map((row) => [row.purchaseOrderLineId, day(row.newDate)]))
}

// The card's state before anyone decided: the check's, or "needs you" when the
// reply was not read (the manual form).
export function supplierReplyCardState(reply) {
  if (reply?.check?.state) return reply.check.state
  return reply?.readingStatus && reply.readingStatus !== 'read' ? 'needs_you' : null
}

// reply: { state, reasonCode, check }. recordedDates: a Map (or object) of
// purchase order line id -> the day recorded, from supplierReplyRecordedDates;
// null or empty when the reply's revisions are not known.
export function supplierReplyOutcome(reply, { recordedDates = null } = {}) {
  const state = String(reply?.state ?? '').trim()
  if (state === 'not_recorded') return reply.reasonCode ? `not_recorded_${reply.reasonCode}` : 'not_recorded'
  if (state !== 'recorded') return state || null
  const proposed = supplierReplyProposedLines(reply.check)
  if (!proposed.length) return 'recorded_manual'
  const recorded = recordedDates instanceof Map ? recordedDates : new Map(Object.entries(recordedDates || {}))
  if (!recorded.size) return 'recorded'
  return proposed.every((line) => recorded.get(line.purchaseOrderLineId) === line.proposedDate) ? 'recorded_unchanged' : 'recorded_edited'
}

// The outcomes in the order §4.12 lists them, for counts and filters.
export const SUPPLIER_REPLY_OUTCOMES = Object.freeze([
  'recorded_unchanged', 'recorded_edited', 'recorded_manual', 'recorded',
  'not_recorded_wrong_reading', 'not_recorded_supplier_will_confirm', 'not_recorded_other',
  'needs_you', 'proposed', 'nothing_to_record', 'superseded',
])
