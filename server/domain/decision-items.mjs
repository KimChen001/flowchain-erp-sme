import { aiSkillDaysBetween } from './ai-skill-signals.mjs'

// Decision items (docs/drafted-decisions-design.md): Today's rows that the
// system prepares a next step for, and what a person decided about each row.
//
// A row of Today's work (server/domain/today-work.mjs) raises one item per
// kind and record. The item is
//   open       nobody has decided yet;
//   decided    set aside ("Not now" until a day, "Not needed" with a reason),
//              chased (a follow-up was sent or copied), accepted (the drafted
//              document was created), or covered (the system found an open
//              request that already covers it);
//   resolved   its row went away after a decision;
//   expired    its row went away before anyone decided.
// A decided item comes back (open again) only when its condition changes
// materially (comesBack). Everything here is pure: the repository stores the
// items and the routes call these functions.

// bill_exception: a supplier invoice the three-way match held (2026-11-13).
export const DRAFTED_DECISION_KINDS = Object.freeze(['reorder_now', 'purchase_order_overdue', 'purchase_request_to_convert', 'bill_exception'])
// The kinds whose card prepares a message to the supplier, so a person may
// record that it was sent or copied ("chased").
export const SUPPLIER_MESSAGE_KINDS = Object.freeze(['purchase_order_overdue', 'bill_exception'])
// Who may decide: every drafted action (a purchase request, a promised date,
// orders from a request) needs this permission, so deciding needs it too.
export const DECISION_PERMISSION = 'procurement.purchase_order.revise'
// What a person may choose; "covered" is recorded by the system only.
export const DECISION_OPTIONS = Object.freeze(['not_now', 'not_needed', 'chased', 'accepted'])
export const SYSTEM_DECISIONS = Object.freeze(['covered'])
export const NOT_NEEDED_REASONS = Object.freeze(['seasonal', 'discontinued', 'covered_elsewhere', 'supplier_confirmed', 'other'])
export const DECISION_NOTE_MAX = 200
// "Not now" may put an item off for at most this many days.
export const NOT_NOW_MAX_DAYS = 90
export const DECISION_RETURN = Object.freeze({
  // A set-aside item comes back after this many days at most.
  maxDays: 30,
  // An approved request left unconverted comes back sooner.
  requestToConvertDays: 14,
  // A chased order comes back after this many workdays with no receipt and
  // no new promised date.
  chasedWorkdays: 3,
  // An order set aside as not needed comes back after this many more days late.
  overdueMoreDays: 7,
})
// The document types an accepted decision may name.
export const DECISION_DOCUMENT_TYPES = Object.freeze(['purchase_request', 'purchase_order'])
const MAX_DOCUMENTS = 20

// The Today area of each kind, as todayHiddenWork names the areas a reader may
// not see (server/domain/today-work-read-service.mjs).
export const DECISION_KIND_AREA = Object.freeze({
  purchase_order_overdue: 'purchasing',
  purchase_order_due: 'purchasing',
  purchase_order_to_approve: 'purchasing',
  purchase_request_to_approve: 'purchasing',
  purchase_request_to_convert: 'purchasing',
  draft_purchase_order: 'purchasing',
  reorder_now: 'inventory',
  bill_exception: 'bills',
  bill_to_approve: 'bills',
  bill_to_match: 'bills',
  bill_awaiting_receipt: 'bills',
  customer_invoice_to_issue: 'customer_invoices',
  receivable_overdue: 'receivables',
  sales_order_to_reserve: 'sales_orders',
  sales_order_to_ship: 'sales_orders',
  contract_notice_due: 'contracts',
  contract_ending: 'contracts',
  contract_past_end: 'contracts',
})

// The areas whose rows could not all be read, from the overview's
// limitations: an item of such an area is not closed because its row is
// missing, since the row may only be unread.
const SOURCE_AREAS = Object.freeze({
  reorder_list: ['inventory'],
  purchase_orders: ['purchasing'],
  customer_invoices: ['customer_invoices'],
  receivables: ['receivables'],
  contracts: ['contracts'],
  database: ['inventory', 'customer_invoices', 'receivables', 'contracts'],
})

const text = (value) => String(value ?? '').trim()
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

export const decisionKey = (row) => `${text(row.kind)}:${text(row.recordId)}`

export function addCalendarDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// The day n workdays (Monday to Friday) after a day.
export function addWorkdays(day, workdays) {
  let current = day
  let left = workdays
  while (left > 0) {
    current = addCalendarDays(current, 1)
    const weekday = new Date(`${current}T00:00:00Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6) left -= 1
  }
  return current
}

// The row's condition when a person decides, kept with the decision so a
// later read can tell whether it changed materially.
export function decisionSnapshot(row, today) {
  const detail = row?.detail || {}
  return {
    decidedOn: today,
    date: row?.date || null,
    overdueDays: Number(row?.overdueDays) || 0,
    shortfall: number(detail.shortfall),
    stockSignal: detail.stockSignal || null,
  }
}

const STOCK_SIGNAL_RANK = Object.freeze({ stock_below_reorder: 0, stock_below_safety: 1, stock_shortage: 2 })
const stockRank = (signal) => STOCK_SIGNAL_RANK[signal] ?? 0

// Whether a decided item comes back as open, given its row on Today now.
// covered: for reorder items, whether an open purchase request still covers
// the item (an item set aside as covered comes back when none does); null
// when this reader cannot see purchase requests, and then it stays.
export function comesBack(item, row, today, { covered = null } = {}) {
  if (!item || item.state !== 'decided' || !row || !isDay(today)) return false
  const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : {}
  const decidedOn = isDay(snapshot.decidedOn) ? snapshot.decidedOn : null
  const daysSince = decidedOn ? aiSkillDaysBetween(decidedOn, today) : 0
  const limit = item.kind === 'purchase_request_to_convert' ? DECISION_RETURN.requestToConvertDays : DECISION_RETURN.maxDays
  switch (item.decision) {
    case 'not_now':
      return isDay(item.returnOn) ? item.returnOn <= today : true
    case 'covered':
      return covered === false
    case 'chased':
      return decidedOn ? addWorkdays(decidedOn, DECISION_RETURN.chasedWorkdays) <= today || (row.date || null) !== (snapshot.date || null) : true
    case 'accepted':
      return daysSince >= limit
    case 'not_needed': {
      if (daysSince >= limit) return true
      const detail = row.detail || {}
      if (item.kind === 'reorder_now') {
        if (stockRank(detail.stockSignal) > stockRank(snapshot.stockSignal)) return true
        const before = number(snapshot.shortfall)
        const now = number(detail.shortfall)
        return before !== null && before > 0 && now !== null && now >= before * 2
      }
      if (item.kind === 'purchase_order_overdue') {
        if ((row.date || null) !== (snapshot.date || null)) return true
        return (Number(row.overdueDays) || 0) >= (Number(snapshot.overdueDays) || 0) + DECISION_RETURN.overdueMoreDays
      }
      return (row.date || null) !== (snapshot.date || null)
    }
    default:
      return false
  }
}

// The areas whose missing rows may close items: those the reader sees, less
// those Today could not read in full.
export function closableAreas({ hidden = [], limitations = [] } = {}) {
  const blocked = new Set(hidden)
  for (const code of limitations) {
    const source = code.startsWith('today_source_unavailable:') ? code.slice('today_source_unavailable:'.length)
      : code === 'today_database_sources_unavailable' ? 'database'
        : code.startsWith('truncated:') ? code.slice('truncated:'.length) : null
    for (const area of SOURCE_AREAS[source] || []) blocked.add(area)
    if (code === 'reorder_not_checked_for_warehouse_scope') blocked.add('inventory')
  }
  return new Set(Object.values(DECISION_KIND_AREA).filter((area) => !blocked.has(area)))
}

// What a read of Today changes: items to raise for new rows, decided items
// that come back, and items whose row went away. items: the live items
// (activeKey set). rows: every row of Today's work for this reader; only the
// drafted kinds raise items, since only they have cards.
// coveredItemIds: reorder items an open purchase request covers now, or null
// when this reader cannot see purchase requests.
export function planDecisionSync(items = [], rows = [], { today, areas = new Set(), coveredItemIds = null } = {}) {
  const byKey = new Map(items.map((item) => [item.activeKey, item]))
  const rowsByKey = new Map(rows.filter((row) => DRAFTED_DECISION_KINDS.includes(row.kind)).map((row) => [decisionKey(row), row]))
  const create = []
  const reopen = []
  const close = []
  for (const [key, row] of rowsByKey) {
    const item = byKey.get(key)
    if (!item) create.push(row)
    else if (comesBack(item, row, today, { covered: coveredItemIds ? coveredItemIds.has(text(row.recordId)) : null })) reopen.push(item)
  }
  for (const item of items) {
    if (rowsByKey.has(item.activeKey)) continue
    if (!areas.has(DECISION_KIND_AREA[item.kind])) continue
    close.push({ item, state: item.state === 'open' ? 'expired' : 'resolved' })
  }
  return { create, reopen, close }
}

// Today's rows in three parts, earliest date first in each: the drafted kinds
// nobody has decided on (waiting), the rows set aside, and the rest (work).
export function arrangeToday(rows = [], items = []) {
  const byKey = new Map(items.map((item) => [item.activeKey, item]))
  const waiting = []
  const setAside = []
  const work = []
  for (const row of rows) {
    const key = decisionKey(row)
    if (!DRAFTED_DECISION_KINDS.includes(row.kind)) { work.push(row); continue }
    const item = byKey.get(key)
    if (item?.state === 'decided') setAside.push({ key, row, item })
    else waiting.push({ key, row, item: item || null })
  }
  return { waiting, setAside, work }
}

const fail = (code, message, field) => Object.assign(new Error(message), { status: 422, code, details: field ? [{ field, message }] : [] })

// A person's decision as the route receives it, checked and normalised.
export function parseDecision(input = {}, { kind, today } = {}) {
  const option = text(input.option)
  if (!DECISION_OPTIONS.includes(option)) throw fail('DECISION_OPTION_INVALID', `Choose one of: ${DECISION_OPTIONS.join(', ')}.`, 'option')
  const note = text(input.note)
  if (note.length > DECISION_NOTE_MAX) throw fail('DECISION_NOTE_TOO_LONG', `Keep the note to ${DECISION_NOTE_MAX} characters.`, 'note')
  if (option === 'not_now') {
    const returnOn = text(input.returnOn)
    if (!isDay(returnOn) || returnOn <= today) throw fail('DECISION_RETURN_DAY_INVALID', 'Choose a day after today.', 'returnOn')
    if (aiSkillDaysBetween(today, returnOn) > NOT_NOW_MAX_DAYS) throw fail('DECISION_RETURN_DAY_INVALID', `Choose a day within ${NOT_NOW_MAX_DAYS} days.`, 'returnOn')
    return { decision: option, returnOn, reasonCode: null, note: note || null }
  }
  if (option === 'not_needed') {
    const reasonCode = text(input.reasonCode)
    if (!NOT_NEEDED_REASONS.includes(reasonCode)) throw fail('DECISION_REASON_INVALID', `Choose a reason: ${NOT_NEEDED_REASONS.join(', ')}.`, 'reasonCode')
    if (reasonCode === 'other' && note.length < 3) throw fail('DECISION_NOTE_REQUIRED', 'Say why in a few words.', 'note')
    return { decision: option, returnOn: null, reasonCode, note: note || null }
  }
  if (option === 'chased') {
    if (!SUPPLIER_MESSAGE_KINDS.includes(kind)) throw fail('DECISION_OPTION_INVALID', 'Only an overdue purchase order or a held supplier invoice can be marked chased.', 'option')
    return { decision: option, returnOn: null, reasonCode: null, note: note || null }
  }
  // accepted: the documents the person created from the draft.
  const documentType = text(input.documentType)
  if (!DECISION_DOCUMENT_TYPES.includes(documentType)) throw fail('DECISION_DOCUMENT_INVALID', `The document type must be one of: ${DECISION_DOCUMENT_TYPES.join(', ')}.`, 'documentType')
  const documentIds = [...new Set((Array.isArray(input.documentIds) ? input.documentIds : []).map(text).filter(Boolean))]
  if (!documentIds.length || documentIds.length > MAX_DOCUMENTS || documentIds.some((id) => id.length > 120)) throw fail('DECISION_DOCUMENT_INVALID', 'Name the documents that were created.', 'documentIds')
  return { decision: option, returnOn: null, reasonCode: null, note: note || null, documentType, documentIds }
}
