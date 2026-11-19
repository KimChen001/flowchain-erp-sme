import { DEFAULT_TENANT_TIMEZONE, tenantCalendarDay } from './tenant-calendar-day.mjs'

// Due dates and ETAs in the older read models (the review-actions queue and
// its control tower) are free text: an ISO date, or a Chinese month and day
// such as "11月20日" with no year. They are judged against the workspace's
// calendar day, not UTC midnight (design audit L6-23).

function utcDayTime(year, month, day) {
  const time = Date.UTC(year, month - 1, day)
  const date = new Date(time)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : null
}

// The workspace's today, as YYYY-MM-DD: the day options.now (default: this
// moment) falls on in options.timeZone (default: the product default).
export function workspaceDueToday({ now, timeZone } = {}) {
  const instant = now instanceof Date ? now : now ? new Date(now) : new Date()
  return tenantCalendarDay(Number.isFinite(instant.getTime()) ? instant : new Date(), timeZone || DEFAULT_TENANT_TIMEZONE)
}

// The calendar day a due date or ETA names, as YYYY-MM-DD, or '' when it
// names none. An ISO date is read as written. A month and day without a year
// takes the year that puts it nearest the reference day (YYYY-MM-DD), so
// "1月5日" read on 28 December is next January, and "12月20日" read on
// 3 January is last December.
export function dueCalendarDay(value, referenceDay) {
  const raw = String(value ?? '').trim()
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return utcDayTime(Number(iso[1]), Number(iso[2]), Number(iso[3])) === null ? '' : `${iso[1]}-${iso[2]}-${iso[3]}`
  const monthDay = raw.match(/(\d{1,2})月(\d{1,2})日/)
  const reference = String(referenceDay ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!monthDay || !reference) return ''
  const referenceYear = Number(reference[1])
  const referenceTime = Date.UTC(referenceYear, Number(reference[2]) - 1, Number(reference[3]))
  let nearest = null
  for (const year of [referenceYear - 1, referenceYear, referenceYear + 1]) {
    const time = utcDayTime(year, Number(monthDay[1]), Number(monthDay[2]))
    if (time !== null && (nearest === null || Math.abs(time - referenceTime) < Math.abs(nearest - referenceTime))) nearest = time
  }
  return nearest === null ? '' : new Date(nearest).toISOString().slice(0, 10)
}

// Whether a due date or ETA falls before the workspace's today (YYYY-MM-DD).
export function isPastDueOn(value, today) {
  const due = dueCalendarDay(value, today)
  return Boolean(due && today && due < today)
}
