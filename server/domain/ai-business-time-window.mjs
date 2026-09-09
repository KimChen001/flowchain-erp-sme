const SUPPORTED_WINDOWS = new Set(['today', 'current_week', 'next_7_days', 'next_30_days', 'month_end', 'overdue', 'all'])

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date)
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function utcForLocal(timezone, year, month, day, hour = 0, minute = 0, second = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess), timezone)
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
    guess += target - represented
  }
  return new Date(guess)
}

function localDate(date, timezone) {
  const parts = zonedParts(date, timezone)
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: parts.weekday }
}

function addLocalDays(local, days) {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function startOfLocalDay(local, timezone) {
  return utcForLocal(timezone, local.year, local.month, local.day)
}

function endBeforeLocalDay(local, timezone) {
  return new Date(startOfLocalDay(local, timezone).getTime() - 1)
}

export function detectBusinessTimeWindow(message = '') {
  const input = String(message || '').toLowerCase()
  if (/今天|今日|today/.test(input)) return 'today'
  if (/本周|这周|this week|current week/.test(input)) return 'current_week'
  if (/月底|月末|month.?end|end of (?:the )?month/.test(input)) return 'month_end'
  if (/未来?\s*30\s*天|接下来\s*30\s*天|next\s*30\s*days?/.test(input)) return 'next_30_days'
  if (/未来?\s*7\s*天|接下来\s*(?:7|七)\s*天|next\s*7\s*days?/.test(input)) return 'next_7_days'
  if (/最近|近期|recent(?:ly)?/.test(input)) return 'next_7_days'
  if (/很快|soon/.test(input)) return 'next_7_days'
  if (/逾期|过期|overdue|past due|expired/.test(input)) return 'overdue'
  return 'all'
}

export function resolveBusinessTimeWindow(kind = 'all', { now = new Date(), timezone = 'UTC', expression = '' } = {}) {
  const normalizedKind = SUPPORTED_WINDOWS.has(kind) ? kind : 'all'
  const resolvedTimezone = validTimezone(timezone) ? timezone : 'UTC'
  const current = now instanceof Date ? now : new Date(now)
  const local = localDate(current, resolvedTimezone)
  const todayStart = startOfLocalDay(local, resolvedTimezone)
  let startAt = null
  let endAt = null
  let interpretation = normalizedKind
  const limitations = []

  if (normalizedKind === 'today') {
    startAt = todayStart
    endAt = endBeforeLocalDay(addLocalDays(local, 1), resolvedTimezone)
  } else if (normalizedKind === 'current_week') {
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday)
    const daysSinceMonday = weekday === 0 ? 6 : weekday - 1
    const monday = addLocalDays(local, -daysSinceMonday)
    startAt = startOfLocalDay(monday, resolvedTimezone)
    endAt = endBeforeLocalDay(addLocalDays(monday, 7), resolvedTimezone)
  } else if (normalizedKind === 'next_7_days' || normalizedKind === 'next_30_days') {
    startAt = todayStart
    endAt = endBeforeLocalDay(addLocalDays(local, normalizedKind === 'next_7_days' ? 7 : 30), resolvedTimezone)
  } else if (normalizedKind === 'month_end') {
    startAt = todayStart
    const nextMonth = new Date(Date.UTC(local.year, local.month, 1))
    endAt = endBeforeLocalDay({ year: nextMonth.getUTCFullYear(), month: nextMonth.getUTCMonth() + 1, day: 1 }, resolvedTimezone)
  } else if (normalizedKind === 'overdue') {
    endAt = new Date(todayStart.getTime() - 1)
    interpretation = 'due before the current workspace-local day'
  }

  if (/最近|近期|recent(?:ly)?/i.test(expression)) limitations.push('“最近”按产品默认的未来 7 天窗口解释。')
  if (/很快|soon/i.test(expression)) limitations.push('“很快”按产品默认的未来 7 天窗口解释；可指定更精确日期。')
  if (resolvedTimezone !== timezone) limitations.push(`无效工作区时区 ${timezone}，已按 UTC 解释。`)
  return {
    type: normalizedKind,
    startAt: startAt?.toISOString() || null,
    endAt: endAt?.toISOString() || null,
    timezone: resolvedTimezone,
    interpretation,
    limitations,
  }
}
