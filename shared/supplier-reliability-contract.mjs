// Supplier reliability (docs/supplier-reply-dates-design.md §4.12, SR-7): how
// often a supplier moves its promised dates and how it answers a chase, per
// supplier, for the supplier evaluation page. One read returns every supplier
// the reader's workspace has, as /api/master-data/supplier-insights does.
//
// It is a measure of its own beside on time: the scorecard stays on the
// original promise (supplier-scorecard.mjs), and nothing here changes it.
//
// Every figure comes with its counts. A share or an average is null under the
// page's minimum sample (the scorecard's 5), when the page shows the counts
// instead ("—"), as it does for on time. Labels are codes the page words
// through i18n.
//
//   window      the scorecard's 90 days ending today in the workspace
//               timezone (SUPPLIER_SCORECARD_RULES.periodDays)
//   orders      the supplier's orders the scorecard measures (issued to the
//               supplier, or something received; not cancelled) with a line
//               promised in the window: its original promise, else its
//               current date, as the scorecard dates a line
//   revisions   changes to those orders' promised dates
//               (PurchaseOrderPromiseRevision), from any source, the
//               buyer's form or a supplier reply. A row without a previous
//               date is the first promise, not a revision; a row that keeps
//               the same day is not one either
//   replies     supplier replies received in the window (receivedOn), each
//               counted once: a paste a later one replaced while open
//               (superseded) is not counted
import { z } from 'zod'

export const SUPPLIER_RELIABILITY_CONTRACT_VERSION = 1
export const SUPPLIER_RELIABILITY_ROUTE = '/api/master-data/supplier-reliability'
// The scorecard's window and minimum sample (SUPPLIER_SCORECARD_RULES
// periodDays and minimumSample); a server test pins them equal.
export const SUPPLIER_RELIABILITY_RULES = Object.freeze({ windowDays: 90, minimumSample: 5 })
export const SUPPLIER_RELIABILITY_ERROR_CODES = Object.freeze(['AUTHENTICATION_REQUIRED', 'SUPPLIER_RELIABILITY_UNAVAILABLE'])

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const count = z.number().int().nonnegative()
// A share with what it counts. share is null when `of` is under the minimum
// sample, or zero.
const shareOf = z.strictObject({ count, of: count, share: z.number().min(0).max(1).nullable() })

export const supplierReliabilityRevisionsSchema = z.strictObject({
  // Orders with a line promised in the window.
  orders: count,
  // Of them, the orders with at least one revision.
  revisedOrders: count,
  // Revisions on those orders' lines.
  revisions: count,
  // revisions / orders; null when orders is under the minimum sample.
  perOrder: z.number().nonnegative().nullable(),
  // The mean of each revision's days moved, later positive, earlier negative,
  // to one decimal; null when revisions is under the minimum sample.
  averageDaysMoved: z.number().nullable(),
  // Revisions that moved the date later, of all revisions.
  movedLater: shareOf,
}).superRefine((row, ctx) => {
  // The totals the page relies on: a server that drifts fails the parse, and
  // the page shows its alert instead of figures that do not add up.
  if (row.movedLater.of !== row.revisions) ctx.addIssue({ code: 'custom', path: ['movedLater', 'of'], message: 'movedLater.of must equal revisions.' })
  if (row.revisedOrders > row.orders) ctx.addIssue({ code: 'custom', path: ['revisedOrders'], message: 'revisedOrders cannot exceed orders.' })
})

// What became of each reply (#363 §4.12): a reply is in exactly one of these,
// so they add up to `received`. The recorded ones follow one rule, the same
// in the outcome export (server/domain/supplier-reply-outcome.mjs):
//   recordedUnchanged  every proposed line recorded as proposed (a line that
//                      needed the person and was filled by hand is no edit)
//   recordedEdited     at least one proposed line's date changed or dropped
//   recordedManual     nothing was proposed (AI off, a failed reading, every
//                      line needing the person) and the person typed the dates
//   notRecorded        dismissed, by the reason the person gave
//   needsYou           open: a date that did not pass the checks, every date
//                      vague, or a reply that could not be read
//   proposed           open: a checked proposal not decided yet
//   nothingToRecord    an auto-reply, or no date at all
export const supplierReliabilityOutcomesSchema = z.strictObject({
  recordedUnchanged: count,
  recordedEdited: count,
  recordedManual: count,
  notRecorded: z.strictObject({ wrong_reading: count, supplier_will_confirm: count, other: count }),
  needsYou: count,
  proposed: count,
  nothingToRecord: count,
})

export const supplierReliabilityRepliesSchema = z.strictObject({
  // Replies received in the window.
  received: count,
  // Of them, the replies the model read (an outage or AI off is not read).
  read: count,
  // Read replies with at least one line that passed the checks with a day
  // (proposed, or the current date confirmed), of the read replies.
  withStatedDate: shareOf,
  outcomes: supplierReliabilityOutcomesSchema,
  // Replies whose dates were recorded, and the median hours from paste (when
  // the reply was entered in FlowChain; receivedOn is only a day) to when its
  // dates were recorded, to one decimal; null when recorded is under the
  // minimum sample.
  recorded: count,
  medianHoursToRecord: z.number().nonnegative().nullable(),
}).superRefine((row, ctx) => {
  const { notRecorded, ...outcomes } = row.outcomes
  const total = Object.values(outcomes).reduce((sum, value) => sum + value, 0) + Object.values(notRecorded).reduce((sum, value) => sum + value, 0)
  if (total !== row.received) ctx.addIssue({ code: 'custom', path: ['outcomes'], message: 'The outcomes must add up to received.' })
  if (row.withStatedDate.of !== row.read) ctx.addIssue({ code: 'custom', path: ['withStatedDate', 'of'], message: 'withStatedDate.of must equal read.' })
  if (row.read > row.received) ctx.addIssue({ code: 'custom', path: ['read'], message: 'read cannot exceed received.' })
  if (row.recorded !== outcomes.recordedUnchanged + outcomes.recordedEdited + outcomes.recordedManual) ctx.addIssue({ code: 'custom', path: ['recorded'], message: 'recorded must equal the recorded outcomes.' })
})

// One supplier. A part is null when the reader may not read it.
export const supplierReliabilityRowSchema = z.strictObject({
  revisions: supplierReliabilityRevisionsSchema.nullable(),
  replies: supplierReliabilityRepliesSchema.nullable(),
})

export const supplierReliabilityResponseSchema = z.strictObject({
  contractVersion: z.literal(SUPPLIER_RELIABILITY_CONTRACT_VERSION),
  asOf: day,
  window: z.strictObject({ from: day, to: day, days: count }),
  minimumSample: count,
  // Both follow purchase order read access, as the list's order columns do.
  visibility: z.strictObject({ revisions: z.boolean(), replies: z.boolean() }),
  // By supplier id, every supplier in the workspace.
  suppliers: z.record(z.string(), supplierReliabilityRowSchema),
})

export const supplierReliabilityErrorSchema = z.strictObject({
  code: z.enum(SUPPLIER_RELIABILITY_ERROR_CODES),
  message: z.string(),
})
