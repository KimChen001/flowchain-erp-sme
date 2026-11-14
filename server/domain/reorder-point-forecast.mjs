import { QUANTITY_SCALE, SUGGESTION_IN_STOCK_TARGET, shippedUnitsPerDay } from './reorder-point-suggestion.mjs'
import { DEFAULT_TENANT_TIMEZONE } from './tenant-calendar-day.mjs'

// A second suggested reorder point from a time-series model: TimesFM 2.5, an
// open model run on the same computer by tools/forecast-service/server.py.
// It answers the same question as the history suggestion
// (reorder-point-suggestion.mjs): how much demand the next H = lead time + 7
// days may bring, at the same in-stock target (5 of 6). The history rule takes
// that from the last 90 days only, so it lags behind seasons; the model reads
// up to two years of shipments.
//
//   history    the quantity shipped on each of the FORECAST_HISTORY_DAYS days
//              before today (same lines, units and workspace days as the list)
//   periods    non-overlapping H-day totals ending yesterday, oldest first, over
//              the days from the item's first shipment on (earlier days are not
//              demand); an incomplete oldest period is dropped
//   forecast   the 5/6 quantile of the next H-day total, rounded up
//
// One period ahead because the level is a quantile of the total over H days:
// adding up daily quantiles would overstate it. No forecast, with a reason,
// when the history suggestion has none (its inputs are missing), when fewer
// than MIN_FORECAST_PERIODS periods remain, or when the service does not
// answer. Nothing is stored: a person sets the reorder point through the
// confirm dialog, as with the history suggestion.
//
// Backtest on public data (M5 Walmart and UCI Online Retail II, weekly review,
// lead time 14 days): about the same stock as the history rule for steady
// items, 26–35% less at the same fill rate for seasonal ones.

export const FORECAST_HISTORY_DAYS = 728
export const MIN_FORECAST_PERIODS = 8
export const FORECAST_MODEL = 'timesfm-2.5-200m'
export const FORECAST_REASONS = Object.freeze({
  noHistorySuggestion: 'no_history_suggestion',
  notEnoughHistory: 'not_enough_history',
  unavailable: 'forecast_unavailable',
})

const rows = (value) => (Array.isArray(value) ? value : [])
const text = (value) => String(value ?? '').trim()

// Non-overlapping `size`-day totals ending on the last day of the series,
// oldest first, over the days from the first shipment on: days before it are
// not demand, and a period reaching back past it would read as a quiet period.
// The incomplete oldest period is dropped.
export function periodTotals(perDay, size) {
  const first = perDay.findIndex((value) => value > 0)
  if (first < 0) return []
  const days = perDay.length - first
  const n = Math.floor(days / size)
  const start = perDay.length - n * size
  return Array.from({ length: n }, (_, period) => {
    let sum = 0
    for (let offset = 0; offset < size; offset += 1) sum += perDay[start + period * size + offset]
    return sum
  })
}

// The client of the forecast service. quantiles(series, q) resolves to
// { values, model } or { values: null, error } and never throws. Answers are
// kept in memory by their exact input, so a refreshed page is not forecast
// again; the oldest half is dropped past CACHE_LIMIT.
const CACHE_LIMIT = 20000

export function createForecastClient({ url, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  const base = text(url).replace(/\/+$/, '')
  if (!base) return null
  const cache = new Map()
  const keyOf = (series, q) => `${q}|${series.join(',')}`
  return {
    url: base,
    async quantiles(series, q) {
      const values = new Array(series.length).fill(undefined)
      const todo = []
      series.forEach((row, index) => {
        const hit = cache.get(keyOf(row, q))
        if (hit === undefined) todo.push(index)
        else values[index] = hit
      })
      if (todo.length) {
        try {
          const response = await fetchImpl(`${base}/v1/quantiles`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ quantile: q, series: todo.map((index) => series[index]) }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!response.ok) return { values: null, error: `status ${response.status}` }
          const body = await response.json()
          if (!Array.isArray(body?.values) || body.values.length !== todo.length) return { values: null, error: 'malformed reply' }
          todo.forEach((index, at) => {
            const value = body.values[at]
            values[index] = Number.isFinite(value) ? value : null
            cache.set(keyOf(series[index], q), values[index])
          })
          if (cache.size > CACHE_LIMIT) [...cache.keys()].slice(0, CACHE_LIMIT / 2).forEach((key) => cache.delete(key))
        } catch (error) {
          return { values: null, error: error?.name === 'TimeoutError' ? 'timeout' : 'not reachable' }
        }
      }
      return { values, model: FORECAST_MODEL }
    },
  }
}

// The client for FLOWCHAIN_FORECAST_URL, one per address; null when unset.
const clients = new Map()
export function forecastClientFromEnv(env = process.env) {
  const url = text(env?.FLOWCHAIN_FORECAST_URL)
  if (!url) return null
  if (!clients.has(url)) clients.set(url, createForecastClient({ url, timeoutMs: Number(env.FLOWCHAIN_FORECAST_TIMEOUT_MS) || 30000 }))
  return clients.get(url)
}

// The reorder list (with reorderPointSuggestion on its rows, as
// attachReorderPointSuggestions leaves it) with reorderPointForecast on each
// row, and forecast: { status, model, error? } on the list. shipmentLines:
// { itemId, unit, quantity, postedAt } over FORECAST_HISTORY_DAYS.
export async function attachReorderPointForecasts(list, shipmentLines = [], { client, historyDays = FORECAST_HISTORY_DAYS, minPeriods = MIN_FORECAST_PERIODS } = {}) {
  if (!client) return list
  const linesByItem = new Map()
  for (const line of rows(shipmentLines)) {
    const key = text(line.itemId)
    if (!linesByItem.has(key)) linesByItem.set(key, [])
    linesByItem.get(key).push(line)
  }
  const timeZone = list.timeZone || DEFAULT_TENANT_TIMEZONE
  const jobs = []
  const forecasts = rows(list?.rows).map((row, index) => {
    const suggestion = row.reorderPointSuggestion
    const coverDays = suggestion?.coverDays ?? null
    const base = { reorderPoint: null, reason: null, model: FORECAST_MODEL, coverDays, periods: 0, historyDays, inStockTarget: SUGGESTION_IN_STOCK_TARGET }
    if (!suggestion || suggestion.suggestedReorderPoint === null || !(coverDays > 0)) return { ...base, reason: FORECAST_REASONS.noHistorySuggestion }
    const perDay = shippedUnitsPerDay({ lines: linesByItem.get(text(row.itemId)), stockUnit: row.unit, today: list.today, timeZone, days: historyDays })
    const totals = periodTotals(perDay, coverDays).map((value) => value / QUANTITY_SCALE)
    if (totals.length < minPeriods) return { ...base, periods: totals.length, reason: FORECAST_REASONS.notEnoughHistory }
    jobs.push({ index, totals })
    return { ...base, periods: totals.length }
  })
  let status = 'ok'
  let error
  if (jobs.length) {
    const answer = await client.quantiles(jobs.map((job) => job.totals), SUGGESTION_IN_STOCK_TARGET)
    if (!answer.values) {
      status = 'unavailable'
      error = answer.error
    }
    jobs.forEach((job, at) => {
      const value = answer.values?.[at]
      forecasts[job.index] = Number.isFinite(value)
        ? { ...forecasts[job.index], reorderPoint: Math.ceil(value) }
        : { ...forecasts[job.index], reason: FORECAST_REASONS.unavailable }
    })
  }
  return {
    ...list,
    forecast: { status, model: FORECAST_MODEL, ...(error ? { error } : {}) },
    rows: rows(list?.rows).map((row, index) => ({ ...row, reorderPointForecast: forecasts[index] })),
  }
}
