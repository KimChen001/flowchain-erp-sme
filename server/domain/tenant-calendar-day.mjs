// The tenant's calendar day. "Today" and "overdue" follow the workspace
// timezone, not UTC: at 22:00 in New York it is already tomorrow in UTC, and
// an order due today must not turn overdue then.
export const DEFAULT_TENANT_TIMEZONE = 'America/New_York'

// The calendar day of an instant in a timezone, as YYYY-MM-DD. An unknown
// timezone falls back to the product default, then to UTC.
export function tenantCalendarDay(instant, timeZone = DEFAULT_TENANT_TIMEZONE) {
  const format = (zone) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  try {
    return format(timeZone || DEFAULT_TENANT_TIMEZONE)
  } catch {
    try {
      return format(DEFAULT_TENANT_TIMEZONE)
    } catch {
      return instant.toISOString().slice(0, 10)
    }
  }
}

// The workspace calendar day of a stored instant: a creation, arrival or
// posting time. A PO entered at 21:00 in New York on Sep 30 is 01:00 UTC on
// Oct 1, and belongs to September. A bare YYYY-MM-DD is already a calendar
// day and is kept as it is. '' when the value is not a real date or time.
// Date-only fields (expected, promised and invoice dates, stored at 00:00 or
// 12:00 UTC) are not instants: they are read with reportCalendarDay instead,
// so they do not move a day earlier in US timezones.
export function instantCalendarDay(value, timeZone = DEFAULT_TENANT_TIMEZONE) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const candidate = value.trim()
    const parsed = new Date(`${candidate}T12:00:00Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : ''
  }
  const instant = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(instant.getTime()) ? tenantCalendarDay(instant, timeZone) : ''
}
