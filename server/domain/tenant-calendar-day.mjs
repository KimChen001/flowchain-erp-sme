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
