import test from 'node:test'
import assert from 'node:assert/strict'
import { isCalendarDay, shippedByWorkspaceDay } from '../../scripts/export-replenishment-inputs.mjs'
import { dailyDemand } from './reorder-list.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'

// scripts/export-replenishment-inputs.mjs: the daily shipped series an
// optimizer reads adds up to what the reorder list's daily demand adds.
const today = '2026-11-03'
const days = Array.from({ length: 90 }, (_, index) => addCalendarDays(addCalendarDays(today, -90), index))
const timeZone = 'America/New_York'
const series = (lines, stockUnit) => shippedByWorkspaceDay({ lines, stockUnit, days, timeZone })
const total = (byDay) => [...byDay.values()].reduce((sum, value) => sum + value, 0)

test('the export adds shipments by workspace day in the stock unit, as the reorder list does', () => {
  const lines = [
    // 01:30 UTC on Nov 2 is still Nov 1 in New York.
    { unit: 'pcs', quantity: 4, postedAt: '2026-11-02T01:30:00Z' },
    { unit: 'PCS', quantity: 6, postedAt: '2026-11-01T18:00:00Z' },
    { unit: '', quantity: 2, postedAt: '2026-10-15T15:00:00Z' },
    // Another unit is counted apart; outside the window is ignored.
    { unit: 'box', quantity: 3, postedAt: '2026-10-15T15:00:00Z' },
    { unit: 'pcs', quantity: 9, postedAt: '2026-11-03T15:00:00Z' },
    { unit: 'pcs', quantity: 9, postedAt: '2026-08-04T15:00:00Z' },
  ]
  const result = series(lines, 'pcs')
  assert.equal(result.byDay.size, 90)
  assert.equal(result.byDay.get('2026-11-01'), 10)
  assert.equal(result.byDay.get('2026-10-15'), 2)
  assert.deepEqual([result.otherUnitLines, result.unitsMixed], [1, []])
  const demand = dailyDemand({ lines, stockUnit: 'pcs', today, timeZone })
  assert.deepEqual([total(result.byDay), [...result.byDay.values()].filter((value) => value > 0).length], [demand.shippedQuantity, demand.shipmentDays])
})

test('without a stock unit, shipments in more than one unit are not added to each other', () => {
  const mixed = [
    { unit: 'pcs', quantity: 10, postedAt: '2026-10-01T15:00:00Z' },
    { unit: 'box', quantity: 2, postedAt: '2026-10-02T15:00:00Z' },
  ]
  const result = series(mixed, '')
  assert.deepEqual([total(result.byDay), result.otherUnitLines, result.unitsMixed], [0, 0, ['pcs', 'box']])
  assert.deepEqual(dailyDemand({ lines: mixed, stockUnit: '', today, timeZone }).unitsMixed, ['pcs', 'box'])
  // One unit throughout is added, as the reorder list adds it.
  const single = [mixed[0], { unit: 'pcs', quantity: 5, postedAt: '2026-10-03T15:00:00Z' }]
  assert.deepEqual([total(series(single, '').byDay), dailyDemand({ lines: single, stockUnit: '', today, timeZone }).shippedQuantity], [15, 15])
})

test('the export takes only calendar days that exist as its as-of day', () => {
  assert.deepEqual(['2026-11-03', '2028-02-29', '2026-02-30', '2026-13-01', '2026-1-3', '', null].map(isCalendarDay), [true, true, false, false, false, false, false])
})
