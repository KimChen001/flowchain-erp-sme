// What a contract shows, read from its dates on the workspace's calendar day
// (docs/contracts-module-design.md §2). People set three statuses: draft,
// active and terminated. Everything else is derived on each read, here, for
// the server (lists, detail, Today) and later the pages:
//
//   draft        being recorded; no reminders.
//   active       signed and in force.
//   notice_due   active, renews automatically, and the last day to give
//                notice (end date minus the notice days) is today or within
//                the reminder days ahead.
//   ending       active, does not renew automatically, and the end date is
//                today or within the reminder days ahead.
//   ended        active, the end date has passed, it does not renew
//                automatically and no renewal was recorded.
//   past_end     active, renews automatically, and the end date has passed:
//                someone should record the new end date. FlowChain never
//                moves a date by itself.
//   renewed      a newer contract that renews it was activated.
//   terminated   ended early by a person, with a date and a reason.
//
// Days are calendar days ("YYYY-MM-DD"). Stored days are kept at 00:00 UTC as
// entered (like due dates since #170) and are read as that UTC day, never in
// a timezone. "Today" is the workspace's day, which the caller works out in
// the workspace timezone (server: tenantCalendarDay), as Today and
// receivables do. An empty end date is open-ended: no reminder, never ends.

export const CONTRACT_TYPES = Object.freeze(['purchase_agreement', 'service_agreement', 'nda', 'quality_agreement', 'other'])
export const CONTRACT_STATUSES = Object.freeze(['draft', 'active', 'terminated'])
export const CONTRACT_RENEWALS = Object.freeze(['none', 'automatic', 'by_agreement'])
export const CONTRACT_STATES = Object.freeze(['draft', 'active', 'notice_due', 'ending', 'ended', 'past_end', 'renewed', 'terminated'])
// "Remind me" defaults to 60 days before the key date (D6).
export const CONTRACT_DEFAULT_REMINDER_DAYS = 60
export const CONTRACT_MAX_NOTICE_DAYS = 730
export const CONTRACT_MAX_REMINDER_DAYS = 365

const DAY_MS = 86_400_000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

// A stored or entered calendar day as YYYY-MM-DD, or '' when it is not a real
// date. A Date (or an ISO instant) keeps its UTC date, the day it was stored
// for; a bare "YYYY-MM-DD" must be a real day ("2026-02-30" is not).
export function contractCalendarDay(value) {
  if (value === null || value === undefined || value === '') return ''
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : ''
  const candidate = String(value).trim().slice(0, 10)
  if (!ISO_DAY.test(candidate)) return ''
  const parsed = new Date(`${candidate}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : ''
}

// Whole days from one calendar day to another (negative when `to` is earlier).
export function contractDaysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

export function addContractDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

const whole = (value, fallback) => {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

// The shown state and the key date of one contract on the workspace day.
//   contract          { status, renewal, endDate, noticeDays, reminderDays,
//                       terminatedOn }; dates as Date, ISO or YYYY-MM-DD
//   today             the workspace's calendar day, YYYY-MM-DD
//   renewalActivated  whether a contract that renews this one was activated
// Returns { state, keyDate, keyDateKind, daysUntilKeyDate, noticeDeadline,
// inReminderWindow }: keyDateKind is 'notice_deadline', 'end', 'terminated'
// or null; daysUntilKeyDate is negative once the key date has passed.
export function contractShownState(contract = {}, { today, renewalActivated = false } = {}) {
  const day = contractCalendarDay(today)
  if (!day) throw new TypeError('contractShownState needs the workspace day as YYYY-MM-DD.')
  const endDate = contractCalendarDay(contract.endDate) || null
  const renewal = CONTRACT_RENEWALS.includes(contract.renewal) ? contract.renewal : 'none'
  const noticeDays = whole(contract.noticeDays, 0)
  const reminderDays = whole(contract.reminderDays, CONTRACT_DEFAULT_REMINDER_DAYS)
  const automatic = renewal === 'automatic'
  const noticeDeadline = automatic && endDate ? addContractDays(endDate, -noticeDays) : null
  const result = (state, keyDate = null, keyDateKind = null) => ({
    state,
    keyDate,
    keyDateKind: keyDate ? keyDateKind : null,
    daysUntilKeyDate: keyDate ? contractDaysBetween(day, keyDate) : null,
    noticeDeadline,
    inReminderWindow: state === 'notice_due' || state === 'ending',
  })

  if (contract.status === 'terminated') return result('terminated', contractCalendarDay(contract.terminatedOn) || null, 'terminated')
  if (contract.status !== 'active') return result('draft')
  if (renewalActivated) return result('renewed', endDate, 'end')
  if (!endDate) return result('active')
  const untilEnd = contractDaysBetween(day, endDate)
  if (untilEnd < 0) return result(automatic ? 'past_end' : 'ended', endDate, 'end')
  if (automatic) {
    const untilDeadline = contractDaysBetween(day, noticeDeadline)
    if (untilDeadline >= 0 && untilDeadline <= reminderDays) return result('notice_due', noticeDeadline, 'notice_deadline')
    // Notice can no longer be given: it renews on its end date.
    return untilDeadline >= 0 ? result('active', noticeDeadline, 'notice_deadline') : result('active', endDate, 'end')
  }
  return result(untilEnd <= reminderDays ? 'ending' : 'active', endDate, 'end')
}
