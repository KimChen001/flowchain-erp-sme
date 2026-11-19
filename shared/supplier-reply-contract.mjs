// Supplier replies (docs/supplier-reply-dates-design.md, #363; built as
// option A of docs/workflow-automation-design.md, #392): a person pastes a
// supplier's reply on an issued order, one tool-less model call reads it,
// code checks every value against the reply and the order, and a card offers
// the new promised dates for the person to record.
//
// The shapes live here once: the server builds and checks them, the card in
// the UI renders them, and the supplier-reply eval scores them. Every label is
// a code the client words through i18n; business values (numbers, SKUs, item
// names, the supplier's own words) are shown as recorded.
//
// The steps run without a database given an order snapshot
// (supplierReplyOrderSchema), for the eval's scorer, from
// server/domain/supplier-reply-reading.mjs:
//   cleanSupplierReply(text)
//     -> { text, quoted, quotedTextHidden, invisibleRemoved }
//   readSupplierReply({ order, text, receivedOn, today, callModel, reserve? })
//     -> { readingStatus, reading, calls, usage }   (callModel is injected)
//   checkReplyReading({ order, text, receivedOn, reading })
//     -> supplierReplyCheckSchema
import { z } from 'zod'

export const SUPPLIER_REPLY_CONTRACT_VERSION = 1
// The prompt the reading call uses; stored with each reading (#363 §5).
export const SUPPLIER_REPLY_PROMPT_VERSION = 'supplier-reply-read-1'

export const SUPPLIER_REPLY_LIMITS = Object.freeze({
  // The assistant's paste limit (QUESTION_LIMITS.assistantV2).
  text: 8000,
  quote: 400,
  note: 200,
  lines: 50,
  flags: 10,
  // A reply gets a reading and one retry after a schema failure (WA-2).
  calls: 2,
  maxOutputTokens: 1000,
  // A new date is on or after the reply date and within this many days.
  horizonDays: 365,
  // Replies listed per order, newest first.
  listed: 20,
})

// The card's state (#363 §5, plus superseded from #392 §2):
//   proposed           at least one line has a checked date to record
//   needs_you          a date was mentioned but did not pass, every date is
//                      vague, or the reply could not be read (an outage or a
//                      reading that failed twice): the manual form
//   nothing_to_record  an auto-reply, or no date at all
//   recorded           the person recorded dates from it
//   not_recorded       the person dismissed it, with a reason
//   superseded         a later reply on the same order replaced it while open
export const SUPPLIER_REPLY_STATES = Object.freeze(['proposed', 'needs_you', 'nothing_to_record', 'recorded', 'not_recorded', 'superseded'])
export const SUPPLIER_REPLY_OPEN_STATES = Object.freeze(['proposed', 'needs_you'])
// How the reading went. Anything but read is an outage or a hand-off: the
// reply is kept and the card shows the manual form (#363 §4.9, #392 app. C).
//   read         the model's reading passed its schema
//   ai_off       the workspace has not switched AI on
//   no_provider  no model is set up on this server
//   over_cap     the workspace's monthly cap, or the reservation, refused it
//   failed       the provider failed or timed out
//   invalid      two readings failed the schema
export const SUPPLIER_REPLY_READING_STATUSES = Object.freeze(['read', 'ai_off', 'no_provider', 'over_cap', 'failed', 'invalid'])
export const SUPPLIER_REPLY_SOURCES = Object.freeze(['paste', 'email'])
export const SUPPLIER_REPLY_KINDS = Object.freeze(['dates', 'confirms', 'no_date', 'auto_reply', 'other'])
export const SUPPLIER_REPLY_DATE_KINDS = Object.freeze(['stated', 'relative', 'vague'])
export const SUPPLIER_REPLY_FLAG_KINDS = Object.freeze(['quantity_change', 'price_change', 'cancellation', 'substitution', 'other_order'])
export const SUPPLIER_REPLY_DISMISS_REASONS = Object.freeze(['wrong_reading', 'supplier_will_confirm', 'other'])
// Why a line is not proposed (each a code the card words):
//   quote_not_found      the quote is not in the cleaned reply
//   date_mismatch        a stated date does not parse from its quote to that day
//   ambiguous_numeric    03/12-style: both readings offered
//   vague                "asap", "early December": no day to propose
//   relative_unreadable  code could not compute a relative date from its quote
//   before_reply         the date is before the reply date
//   too_far              more than horizonDays after the reply date
//   unknown_line         the line reference is not one of the order's open lines
//   not_open             the line has nothing left to receive, or the order
//                        no longer takes dates
//   unchanged            the date is the line's current promised date
//   split_incomplete     a split delivery's parts do not cover what is open
//   several_dates        the quote names more than one date, and this one is
//                        the line's current promise or the one it replaces
//                        (both offered in readings when there are two)
export const SUPPLIER_REPLY_LINE_ISSUES = Object.freeze(['quote_not_found', 'date_mismatch', 'ambiguous_numeric', 'vague', 'relative_unreadable', 'before_reply', 'too_far', 'unknown_line', 'not_open', 'unchanged', 'split_incomplete', 'several_dates'])
// What became of one line of the reading.
export const SUPPLIER_REPLY_LINE_OUTCOMES = Object.freeze(['proposed', 'needs_you', 'dropped', 'confirmed'])

const id = z.string().min(1).max(120)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const quote = z.string().min(1).max(SUPPLIER_REPLY_LIMITS.quote)
const quantity = z.number().finite().nonnegative()
const lineRef = z.string().regex(/^L\d{1,3}$/)

// --- The order as the reading sees it ---------------------------------------

// One open line, with the reference the model answers with (L1, L2, ...).
// No prices: the reading does not need them (#363 §4.4).
export const supplierReplyOrderLineSchema = z.strictObject({
  ref: lineRef,
  purchaseOrderLineId: id,
  sku: z.string().max(120).nullable(),
  // The supplier's own code for the item (its item-supplier link), which a
  // reply often quotes instead of ours.
  supplierSku: z.string().max(120).nullable(),
  itemName: z.string().max(200).nullable(),
  remaining: quantity.nullable(),
  unit: z.string().max(40).nullable(),
  promisedDate: day.nullable(),
})

// The order snapshot clean/read/check take, from the database or from an
// eval case: they run without a database given this.
export const supplierReplyOrderSchema = z.strictObject({
  id: id.optional(),
  number: z.string().min(1).max(120),
  supplierName: z.string().max(200).nullable(),
  status: z.string().max(40),
  lines: z.array(supplierReplyOrderLineSchema).max(200),
})

// --- The model's reading (#392 appendix D) -----------------------------------

export const supplierReplyReadingSchema = z.strictObject({
  replyKind: z.enum(SUPPLIER_REPLY_KINDS),
  lines: z.array(z.strictObject({
    // A reference from the open lines given.
    line: lineRef,
    // Null when the reply names no day (a vague date).
    date: day.nullable(),
    quote,
    dateKind: z.enum(SUPPLIER_REPLY_DATE_KINDS),
    // For a split delivery, this part's quantity; null otherwise.
    quantity: quantity.nullable().optional(),
  })).max(SUPPLIER_REPLY_LIMITS.lines),
  flags: z.array(z.strictObject({ kind: z.enum(SUPPLIER_REPLY_FLAG_KINDS), quote })).max(SUPPLIER_REPLY_LIMITS.flags),
  // The supplier's reason for the date, as a quote; null when none is given.
  reason: quote.nullable().optional(),
})

// --- The checked reading, stored on the reply --------------------------------

// A relative date as code computed it: the phrase, the day it counts from
// and the day it gives ("read as Fri 27 Nov 2026, from the reply date 17 Nov").
export const supplierReplyReadAsSchema = z.strictObject({ phrase: z.string().min(1).max(80), from: day, date: day })

export const supplierReplyCheckedLineSchema = z.strictObject({
  ref: lineRef.nullable(),
  purchaseOrderLineId: id.nullable(),
  outcome: z.enum(SUPPLIER_REPLY_LINE_OUTCOMES),
  issue: z.enum(SUPPLIER_REPLY_LINE_ISSUES).nullable(),
  // The line's promised date when read, and the date proposed (null unless
  // proposed or confirmed).
  currentDate: day.nullable(),
  proposedDate: day.nullable(),
  quote: quote.nullable(),
  dateKind: z.enum(SUPPLIER_REPLY_DATE_KINDS).nullable(),
  readAs: supplierReplyReadAsSchema.nullable(),
  // An ambiguous numeric date's two readings, for the person to pick.
  readings: z.array(day).max(2).nullable(),
  // A split delivery's parts; the proposed date is the last part's.
  parts: z.array(z.strictObject({ quantity: quantity.nullable(), date: day, quote })).max(10).nullable(),
})

export const supplierReplyCheckedFlagSchema = z.strictObject({
  kind: z.enum(SUPPLIER_REPLY_FLAG_KINDS),
  quote,
  // For other_order: the order number the quote names, when one is found.
  orderNumber: z.string().max(120).nullable(),
})

export const supplierReplyCheckSchema = z.strictObject({
  state: z.enum(['proposed', 'needs_you', 'nothing_to_record']),
  replyKind: z.enum(SUPPLIER_REPLY_KINDS).nullable(),
  lines: z.array(supplierReplyCheckedLineSchema).max(SUPPLIER_REPLY_LIMITS.lines * 2),
  flags: z.array(supplierReplyCheckedFlagSchema).max(SUPPLIER_REPLY_LIMITS.flags),
  reason: quote.nullable(),
  // Values the model gave that the reply does not contain (dropped).
  dropped: z.number().int().nonnegative(),
})

// --- The card view, rendered per reader ----------------------------------------

// One line on the card: the stored check joined with the order as the reader
// may read it now (names, quantities; never a price).
export const supplierReplyCardLineSchema = supplierReplyCheckedLineSchema.extend({
  sku: z.string().max(120).nullable(),
  supplierSku: z.string().max(120).nullable(),
  itemName: z.string().max(200).nullable(),
  remaining: quantity.nullable(),
  unit: z.string().max(40).nullable(),
  overdueDays: z.number().int().nonnegative().nullable(),
})

export const supplierReplyDecisionSchema = z.strictObject({
  option: z.enum(['recorded', 'not_recorded']),
  reason: z.enum(SUPPLIER_REPLY_DISMISS_REASONS).nullable(),
  note: z.string().max(SUPPLIER_REPLY_LIMITS.note).nullable(),
  decidedById: id,
  decidedAt: z.string().min(1).max(40),
  // How many lines the person changed from the proposal before recording.
  editedLines: z.number().int().nonnegative(),
  revisionIds: z.array(id).max(SUPPLIER_REPLY_LIMITS.lines),
})

export const supplierReplyCardSchema = z.strictObject({
  contractVersion: z.literal(SUPPLIER_REPLY_CONTRACT_VERSION),
  id,
  purchaseOrderId: id,
  purchaseOrderNumber: z.string().min(1).max(120),
  // The order's version when the card was rendered: sent back as
  // expectedVersion, so a stale card is refused.
  orderVersion: z.number().int().nonnegative(),
  // The order's supplier as the order shows it; null when none is recorded.
  supplierName: z.string().max(200).nullable(),
  source: z.enum(SUPPLIER_REPLY_SOURCES),
  receivedOn: day,
  createdAt: z.string().min(1).max(40),
  state: z.enum(SUPPLIER_REPLY_STATES),
  readingStatus: z.enum(SUPPLIER_REPLY_READING_STATUSES),
  replyKind: z.enum(SUPPLIER_REPLY_KINDS).nullable(),
  // The cleaned reply, as read. The quoted earlier message and a signature
  // are kept apart in quotedText for display (null when nothing was cut); they
  // are never read.
  text: z.string().max(SUPPLIER_REPLY_LIMITS.text),
  quotedTextHidden: z.boolean(),
  quotedText: z.string().max(SUPPLIER_REPLY_LIMITS.text).nullable(),
  lines: z.array(supplierReplyCardLineSchema).max(SUPPLIER_REPLY_LIMITS.lines * 2),
  flags: z.array(supplierReplyCheckedFlagSchema).max(SUPPLIER_REPLY_LIMITS.flags),
  reason: quote.nullable(),
  // The reply holds text addressed to the system; it was not followed. Shown
  // only: nothing relies on it (#392 §3).
  instructionsIgnored: z.boolean(),
  // The order's open lines for the manual form when the card needs the
  // person (or for Edit): ids, names, quantities and current dates.
  formLines: z.array(supplierReplyCardLineSchema.pick({ purchaseOrderLineId: true, sku: true, supplierSku: true, itemName: true, remaining: true, unit: true, currentDate: true, overdueDays: true })).max(200),
  // Whether this reader may record or dismiss it now.
  canDecide: z.boolean(),
  notNowUntil: day.nullable(),
  decision: supplierReplyDecisionSchema.nullable(),
  supersededById: id.nullable(),
})

// --- Routes --------------------------------------------------------------------
//
//   POST /api/procurement/orders/:id/supplier-replies                    paste
//   GET  /api/procurement/orders/:id/supplier-replies                    list
//   POST /api/procurement/orders/:id/supplier-replies/:replyId/record    record
//   POST /api/procurement/orders/:id/supplier-replies/:replyId/dismiss   dismiss
//   POST /api/procurement/orders/:id/supplier-replies/:replyId/not-now   not now
//
// Reading follows the order's read permission; pasting, recording and
// dismissing need procurement.purchase_order.revise. Errors use the
// procurement routes' { code, message, details } body.

// The error codes the routes answer with, by status, beyond the app's
// usual 401 TENANT_CONTEXT_REQUIRED and 403 AUTHORIZATION_PERMISSION_DENIED:
//   400 SUPPLIER_REPLY_INVALID_BODY       the body is not JSON
//   404 PURCHASE_ORDER_NOT_FOUND          not in the reader's workspace
//   404 SUPPLIER_REPLY_NOT_FOUND          not a reply on this order
//   409 SYNC_VERSION_CONFLICT             a stale card: expectedVersion is not
//                                         the order's version (details holds
//                                         currentVersion); reload the card
//   409 SUPPLIER_REPLY_NOT_OPEN           already recorded, dismissed or
//                                         superseded (details[0].code: the state)
//   409 SUPPLIER_REPLY_ORDER_NOT_OPEN     a paste on an order that is not issued
//                                         or partly received
//   409 SUPPLIER_REPLY_CONFLICT           two pastes on one order at once
//   409 TRANSACTION_CONFLICT              a database race; try again
//   422 SUPPLIER_REPLY_INVALID            the body fails its schema (details:
//                                         [{ field, code }])
//   422 SUPPLIER_REPLY_EMPTY              nothing left once quoted text is cut
//   422 SUPPLIER_REPLY_RECEIVED_IN_FUTURE receivedOn after today
//   422 SUPPLIER_REPLY_NO_DATES           record with no proposed or given line
//   422 PROMISED_DATE_UNCHANGED and the promised-dates command's other codes
export const SUPPLIER_REPLY_ERROR_CODES = Object.freeze(['SUPPLIER_REPLY_INVALID_BODY', 'PURCHASE_ORDER_NOT_FOUND', 'SUPPLIER_REPLY_NOT_FOUND', 'SYNC_VERSION_CONFLICT', 'SUPPLIER_REPLY_NOT_OPEN', 'SUPPLIER_REPLY_ORDER_NOT_OPEN', 'SUPPLIER_REPLY_CONFLICT', 'TRANSACTION_CONFLICT', 'SUPPLIER_REPLY_INVALID', 'SUPPLIER_REPLY_EMPTY', 'SUPPLIER_REPLY_RECEIVED_IN_FUTURE', 'SUPPLIER_REPLY_NO_DATES'])

export const SUPPLIER_REPLY_ROUTES = Object.freeze({
  list: '/api/procurement/orders/:id/supplier-replies',
  paste: '/api/procurement/orders/:id/supplier-replies',
  record: '/api/procurement/orders/:id/supplier-replies/:replyId/record',
  dismiss: '/api/procurement/orders/:id/supplier-replies/:replyId/dismiss',
  notNow: '/api/procurement/orders/:id/supplier-replies/:replyId/not-now',
})

export const supplierReplyPasteRequestSchema = z.strictObject({
  text: z.string().min(1).max(SUPPLIER_REPLY_LIMITS.text),
  // The day the reply was received; today in the workspace when omitted. It
  // anchors relative dates.
  receivedOn: day.optional(),
})

export const supplierReplyRecordRequestSchema = z.strictObject({
  // The order's version from the card (orderVersion).
  expectedVersion: z.number().int().nonnegative(),
  // Omitted: the proposed dates. Given: the dates to record, edited or
  // entered on the manual form, per line.
  lines: z.array(z.strictObject({ purchaseOrderLineId: id, promisedDate: day })).min(1).max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

export const supplierReplyDismissRequestSchema = z.strictObject({
  reason: z.enum(SUPPLIER_REPLY_DISMISS_REASONS),
  note: z.string().max(SUPPLIER_REPLY_LIMITS.note).optional(),
}).refine((value) => value.reason !== 'other' || Boolean(value.note?.trim()), { message: 'A note is required with reason other.', path: ['note'] })

export const supplierReplyNotNowRequestSchema = z.strictObject({})

export const supplierReplyCardResponseSchema = z.strictObject({ reply: supplierReplyCardSchema })
export const supplierReplyListResponseSchema = z.strictObject({ replies: z.array(supplierReplyCardSchema).max(SUPPLIER_REPLY_LIMITS.listed) })
export const supplierReplyRecordResponseSchema = z.strictObject({
  reply: supplierReplyCardSchema,
  purchaseOrder: z.strictObject({ id, version: z.number().int().nonnegative() }),
})
