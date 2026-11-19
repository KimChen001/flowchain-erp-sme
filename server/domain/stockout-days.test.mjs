import test from 'node:test'
import assert from 'node:assert/strict'
import { STOCK_HISTORY_REASONS, movementDay, stockoutDays } from './stockout-days.mjs'

// Five window days, Nov 1-5; today is Nov 6.
const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']

test('works the end-of-day stock back from now through the movements, and counts the days that ended with none', () => {
  // 10 received on Nov 1, 10 shipped on Nov 2 (none left on Nov 2 and 3),
  // 20 received on Nov 4, 5 shipped on Nov 6 (today): 15 on hand now.
  const movements = [
    { day: '2026-11-01', quantityIn: 10, quantityOut: 0 },
    { day: '2026-11-02', quantityIn: 0, quantityOut: 10 },
    { day: '2026-11-04', quantityIn: 20, quantityOut: 0 },
    { day: '2026-11-06', quantityIn: 0, quantityOut: 5 },
  ]
  assert.deepEqual(stockoutDays({ onHandNow: 15, movements, days, firstDay: '2026-11-01' }), { stockoutDays: 2, trackedDays: 5, reason: null })
})

test('a transfer between warehouses cancels out, and days before the first movement are not counted', () => {
  const movements = [
    { day: '2026-11-03', quantityIn: 30, quantityOut: 0 },
    { day: '2026-11-04', quantityIn: 0, quantityOut: 12 },
    { day: '2026-11-04', quantityIn: 12, quantityOut: 0 },
  ]
  // Stock was first recorded on Nov 3, so Nov 1 and 2 (no stock) are not stockouts.
  assert.deepEqual(stockoutDays({ onHandNow: 30, movements, days, firstDay: '2026-11-03' }), { stockoutDays: 0, trackedDays: 3, reason: null })
})

test('no movements at all, or a history that works back to a negative stock, gives no count and says why', () => {
  assert.deepEqual(stockoutDays({ onHandNow: 40, movements: [], days, firstDay: null }), { stockoutDays: null, trackedDays: 0, reason: STOCK_HISTORY_REASONS.notTracked })
  // 5 on hand now after 20 shipped on Nov 5: 25 before, but a receipt of 30 on
  // Nov 2 then leaves -5 at the end of Nov 1, so the balance and movements disagree.
  const movements = [{ day: '2026-11-02', quantityIn: 30, quantityOut: 0 }, { day: '2026-11-05', quantityIn: 0, quantityOut: 20 }]
  assert.deepEqual(stockoutDays({ onHandNow: 5, movements, days, firstDay: '2026-10-01' }), { stockoutDays: null, trackedDays: 0, reason: STOCK_HISTORY_REASONS.inconsistent })
})

test('a movement\'s day is its business date in the workspace timezone, else when it was recorded', () => {
  assert.equal(movementDay({ movementDate: new Date('2026-11-04T03:00:00Z'), occurredAt: new Date('2026-11-05T15:00:00Z') }, 'America/New_York'), '2026-11-03')
  assert.equal(movementDay({ movementDate: null, occurredAt: '2026-11-05T15:00:00Z' }, 'America/New_York'), '2026-11-05')
  assert.equal(movementDay({}, 'America/New_York'), null)
})
