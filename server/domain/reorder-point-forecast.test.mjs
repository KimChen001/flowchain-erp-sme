import test from 'node:test'
import assert from 'node:assert/strict'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import {
  FORECAST_HISTORY_DAYS,
  FORECAST_REASONS,
  MIN_FORECAST_PERIODS,
  attachReorderPointForecasts,
  createForecastClient,
  forecastClientFromEnv,
  periodTotals,
} from './reorder-point-forecast.mjs'
import { SUGGESTION_IN_STOCK_TARGET } from './reorder-point-suggestion.mjs'

// server/domain/reorder-point-forecast.mjs: the TimesFM suggestion beside the
// history one, from H-day shipment totals over up to two years.
const today = '2026-11-14'
const timeZone = 'America/New_York'
// days before today -> a posted line at noon in New York
const shipped = (itemId, daysAgo, quantity, unit = 'pcs') => ({ itemId, unit, quantity, postedAt: `${addCalendarDays(today, -daysAgo)}T16:00:00Z` })

test('period totals end yesterday and cover only the days from the first shipment on, in whole periods', () => {
  // Shipments from day 2: [9,0,2,0,1,1,1] in periods of 3 -> the incomplete oldest day is dropped -> [0,2,0], [1,1,1]
  assert.deepEqual(periodTotals([0, 0, 9, 0, 2, 0, 1, 1, 1], 3), [2, 3])
  // Quiet periods after the first shipment are demand too.
  assert.deepEqual(periodTotals([9, 0, 0, 0, 0, 2, 0, 1, 1, 1], 3), [0, 2, 3])
  assert.deepEqual(periodTotals([1, 2, 3, 4, 5, 6], 2), [3, 7, 11])
  assert.deepEqual(periodTotals([0, 0, 0, 0], 2), [])
  assert.deepEqual(periodTotals([1, 1], 3), [])
})

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return handler(url, JSON.parse(init.body))
  }
  return { impl, calls }
}
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('the client posts the series and the quantile, keeps answers by input and never throws', async () => {
  const fetch = fakeFetch((_url, body) => reply({ values: body.series.map((row) => row.reduce((a, b) => a + b, 0)) }))
  const client = createForecastClient({ url: 'http://127.0.0.1:18850/', fetchImpl: fetch.impl })
  assert.equal(client.url, 'http://127.0.0.1:18850')
  const first = await client.quantiles([[1, 2], [3, 4]], 0.8)
  assert.deepEqual(first.values, [3, 7])
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:18850/v1/quantiles')
  assert.deepEqual(fetch.calls[0].body, { quantile: 0.8, series: [[1, 2], [3, 4]] })
  // A repeated series is answered from memory; only the new one is sent.
  const second = await client.quantiles([[3, 4], [5, 6]], 0.8)
  assert.deepEqual(second.values, [7, 11])
  assert.deepEqual(fetch.calls[1].body.series, [[5, 6]])
  // Everything known: no call at all.
  await client.quantiles([[1, 2]], 0.8)
  assert.equal(fetch.calls.length, 2)

  const down = createForecastClient({ url: 'http://x', fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(await down.quantiles([[1]], 0.8), { values: null, error: 'not reachable' })
  const failing = createForecastClient({ url: 'http://x', fetchImpl: async () => reply({ error: 'x' }, 500) })
  assert.deepEqual(await failing.quantiles([[1]], 0.8), { values: null, error: 'status 500' })
  const malformed = createForecastClient({ url: 'http://x', fetchImpl: async () => reply({ values: [1, 2] }) })
  assert.deepEqual(await malformed.quantiles([[1]], 0.8), { values: null, error: 'malformed reply' })
  assert.equal(createForecastClient({ url: '  ' }), null)
})

test('the client comes from FLOWCHAIN_FORECAST_URL, one per address', () => {
  assert.equal(forecastClientFromEnv({}), null)
  const a = forecastClientFromEnv({ FLOWCHAIN_FORECAST_URL: 'http://127.0.0.1:18850' })
  assert.ok(a)
  assert.equal(forecastClientFromEnv({ FLOWCHAIN_FORECAST_URL: 'http://127.0.0.1:18850' }), a)
})

// A reorder list as attachReorderPointSuggestions leaves it.
const row = (itemId, coverDays, suggested = 100) => ({
  itemId,
  sku: itemId,
  unit: 'pcs',
  reorderPoint: 50,
  reorderPointSuggestion: { suggestedReorderPoint: suggested, coverDays, reason: suggested === null ? 'not_enough_history' : null },
})

test('each row gets the 5/6 quantile of its next H-day total, rounded up, from at least 8 periods', async () => {
  const lines = []
  // A: 21-day periods, 10 units every 3 days over 300 days -> 14 full periods of 70 (the oldest is incomplete and dropped)
  for (let d = 1; d <= 300; d += 3) lines.push(shipped('A', d, 10))
  // B: sold only in the last 100 days -> fewer than 8 periods of 21 days
  for (let d = 1; d <= 100; d += 5) lines.push(shipped('B', d, 4))
  // C: a line in another unit is not counted, so C has no history at all
  lines.push(shipped('C', 2, 99, 'box'))
  const seen = []
  const client = { quantiles: async (series, q) => { seen.push({ series, q }); return { values: series.map(() => 77.2), model: 'm' } } }
  const list = { today, timeZone, rows: [row('A', 21), row('B', 21), row('C', 21), row('D', null, null)] }
  const out = await attachReorderPointForecasts(list, lines, { client })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].q, SUGGESTION_IN_STOCK_TARGET)
  assert.equal(seen[0].series.length, 1)
  assert.ok(seen[0].series[0].length >= MIN_FORECAST_PERIODS)
  assert.ok(seen[0].series[0].every((value) => value === 70), JSON.stringify(seen[0].series[0]))
  const [a, b, c, d] = out.rows.map((r) => r.reorderPointForecast)
  assert.equal(a.reorderPoint, 78)
  assert.equal(a.reason, null)
  assert.equal(a.coverDays, 21)
  assert.equal(a.historyDays, FORECAST_HISTORY_DAYS)
  assert.equal(b.reorderPoint, null)
  assert.equal(b.reason, FORECAST_REASONS.notEnoughHistory)
  assert.equal(c.reason, FORECAST_REASONS.notEnoughHistory)
  assert.equal(c.periods, 0)
  assert.equal(d.reason, FORECAST_REASONS.noHistorySuggestion)
  assert.deepEqual(out.forecast, { status: 'ok', model: 'timesfm-2.5-200m' })
  // The rest of the row and the list are untouched.
  assert.equal(out.rows[0].reorderPoint, 50)
  assert.equal(out.today, today)
})

test('when the service does not answer, the list says so and no row gets a number', async () => {
  const lines = []
  for (let d = 1; d <= 300; d += 2) lines.push(shipped('A', d, 3))
  const client = { quantiles: async () => ({ values: null, error: 'timeout' }) }
  const out = await attachReorderPointForecasts({ today, timeZone, rows: [row('A', 21)] }, lines, { client })
  assert.deepEqual(out.forecast, { status: 'unavailable', model: 'timesfm-2.5-200m', error: 'timeout' })
  assert.equal(out.rows[0].reorderPointForecast.reorderPoint, null)
  assert.equal(out.rows[0].reorderPointForecast.reason, FORECAST_REASONS.unavailable)
})

test('without a client the list is returned as it is', async () => {
  const list = { today, timeZone, rows: [row('A', 21)] }
  assert.equal(await attachReorderPointForecasts(list, [], { client: null }), list)
})
