import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTRACT_DEFAULT_REMINDER_DAYS,
  CONTRACT_STATES,
  addContractDays,
  contractCalendarDay,
  contractDaysBetween,
  contractShownState,
} from '../../shared/contract-status.mjs'
import { tenantCalendarDay } from './tenant-calendar-day.mjs'

// What a contract shows on the workspace day (shared/contract-status.mjs):
// three stored statuses, the rest read from the dates.

const active = (overrides = {}) => ({ status: 'active', renewal: 'none', startDate: '2026-01-01', endDate: '2026-12-31', noticeDays: 0, reminderDays: 60, ...overrides })
const shown = (contract, today, options = {}) => contractShownState(contract, { today, ...options })
const state = (contract, today, options) => shown(contract, today, options).state

test('calendar days are read as the day stored, never in a timezone', () => {
  assert.equal(contractCalendarDay(new Date('2026-12-31T00:00:00.000Z')), '2026-12-31')
  assert.equal(contractCalendarDay('2026-12-31T00:00:00.000Z'), '2026-12-31')
  assert.equal(contractCalendarDay('2026-12-31'), '2026-12-31')
  assert.equal(contractCalendarDay('2026-02-30'), '')
  assert.equal(contractCalendarDay('31/12/2026'), '')
  assert.equal(contractCalendarDay(null), '')
  assert.equal(contractCalendarDay(new Date('not a date')), '')
  assert.equal(contractDaysBetween('2026-12-01', '2026-12-31'), 30)
  assert.equal(contractDaysBetween('2026-12-31', '2026-12-01'), -30)
  // Across the US change to winter time a day is still one day.
  assert.equal(contractDaysBetween('2026-10-31', '2026-11-02'), 2)
  assert.equal(addContractDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addContractDays('2028-03-01', -1), '2028-02-29')
})

test('drafts and terminated contracts show their status, whatever the dates', () => {
  assert.deepEqual(shown({ status: 'draft', endDate: '2026-01-01' }, '2026-10-09'), { state: 'draft', keyDate: null, keyDateKind: null, daysUntilKeyDate: null, noticeDeadline: null, inReminderWindow: false })
  const terminated = shown(active({ status: 'terminated', terminatedOn: '2026-09-30' }), '2026-10-09')
  assert.deepEqual([terminated.state, terminated.keyDate, terminated.keyDateKind, terminated.daysUntilKeyDate], ['terminated', '2026-09-30', 'terminated', -9])
  // A renewal recorded for a terminated contract does not make it renewed.
  assert.equal(state(active({ status: 'terminated', terminatedOn: '2026-09-30' }), '2026-10-09', { renewalActivated: true }), 'terminated')
  assert.equal(state({ status: 'draft' }, '2026-10-09', { renewalActivated: true }), 'draft')
})

test('an open-ended contract stays active and never reminds', () => {
  for (const renewal of ['none', 'automatic', 'by_agreement']) {
    const result = shown(active({ endDate: null, renewal, noticeDays: 90 }), '2099-01-01')
    assert.deepEqual([result.state, result.keyDate, result.noticeDeadline, result.inReminderWindow], ['active', null, null, false], renewal)
  }
})

test('without automatic renewal: active, then ending inside the reminder window, then ended after the end date', () => {
  const contract = active({ endDate: '2026-12-31', reminderDays: 60 })
  // 61 days before: outside the window.
  assert.deepEqual([state(contract, '2026-10-31'), shown(contract, '2026-10-31').keyDate, shown(contract, '2026-10-31').daysUntilKeyDate], ['active', '2026-12-31', 61])
  // 60 days before: the first day of the window.
  assert.deepEqual([state(contract, '2026-11-01'), shown(contract, '2026-11-01').daysUntilKeyDate, shown(contract, '2026-11-01').inReminderWindow], ['ending', 60, true])
  // The end date itself is still ending, not ended.
  assert.deepEqual([state(contract, '2026-12-31'), shown(contract, '2026-12-31').daysUntilKeyDate], ['ending', 0])
  // The day after: ended, with the end date as the key date.
  const after = shown(contract, '2027-01-01')
  assert.deepEqual([after.state, after.keyDate, after.keyDateKind, after.daysUntilKeyDate, after.inReminderWindow], ['ended', '2026-12-31', 'end', -1, false])
  // Renew by agreement reminds about the end date in the same way.
  assert.equal(state(active({ renewal: 'by_agreement' }), '2026-11-01'), 'ending')
  assert.equal(state(active({ renewal: 'by_agreement' }), '2027-01-01'), 'ended')
})

test('a reminder of 0 days reminds on the key date only', () => {
  const contract = active({ reminderDays: 0 })
  assert.equal(state(contract, '2026-12-30'), 'active')
  assert.equal(state(contract, '2026-12-31'), 'ending')
  assert.equal(state(contract, '2027-01-01'), 'ended')
})

test('a missing reminder uses the 60-day default', () => {
  assert.equal(CONTRACT_DEFAULT_REMINDER_DAYS, 60)
  const contract = active({ reminderDays: undefined })
  assert.equal(state(contract, '2026-10-31'), 'active')
  assert.equal(state(contract, '2026-11-01'), 'ending')
})

test('automatic renewal reminds about the last day to give notice, not the end date', () => {
  // Ends Dec 31 with 30 days' notice: the last day to give notice is Dec 1.
  const contract = active({ renewal: 'automatic', noticeDays: 30, reminderDays: 60 })
  const before = shown(contract, '2026-10-01')
  assert.deepEqual([before.state, before.keyDate, before.keyDateKind, before.noticeDeadline], ['active', '2026-12-01', 'notice_deadline', '2026-12-01'])
  const first = shown(contract, '2026-10-02')
  assert.deepEqual([first.state, first.keyDate, first.daysUntilKeyDate, first.inReminderWindow], ['notice_due', '2026-12-01', 60, true])
  assert.equal(state(contract, '2026-12-01'), 'notice_due')
  // Once notice can no longer be given it renews on its end date: active,
  // with the end date as the key date, and never "ending".
  const missed = shown(contract, '2026-12-02')
  assert.deepEqual([missed.state, missed.keyDate, missed.keyDateKind], ['active', '2026-12-31', 'end'])
  assert.equal(state(contract, '2026-12-31'), 'active')
  // After the end date nobody recorded the new one: past its end.
  const past = shown(contract, '2027-01-01')
  assert.deepEqual([past.state, past.keyDate, past.daysUntilKeyDate], ['past_end', '2026-12-31', -1])
})

test('automatic renewal with no notice period: the notice deadline is the end date', () => {
  const contract = active({ renewal: 'automatic', noticeDays: 0, reminderDays: 10 })
  assert.equal(state(contract, '2026-12-20'), 'active')
  assert.deepEqual([state(contract, '2026-12-21'), shown(contract, '2026-12-21').keyDate], ['notice_due', '2026-12-31'])
  assert.equal(state(contract, '2026-12-31'), 'notice_due')
  assert.equal(state(contract, '2027-01-01'), 'past_end')
})

test('a notice period longer than the contract puts the deadline before the start, and it is never due after it passed', () => {
  const contract = active({ renewal: 'automatic', startDate: '2026-12-01', endDate: '2026-12-31', noticeDays: 90, reminderDays: 30 })
  assert.equal(shown(contract, '2026-10-09').noticeDeadline, '2026-10-02')
  assert.equal(state(contract, '2026-10-09'), 'active')
  assert.equal(state(contract, '2026-10-02'), 'notice_due')
})

test('an activated renewal shows the old contract renewed, before or after its end date', () => {
  for (const today of ['2026-11-15', '2027-03-01']) {
    for (const renewal of ['none', 'automatic', 'by_agreement']) {
      const result = shown(active({ renewal, noticeDays: 30 }), today, { renewalActivated: true })
      assert.deepEqual([result.state, result.keyDate, result.inReminderWindow], ['renewed', '2026-12-31', false], `${today} ${renewal}`)
    }
  }
})

test('stored dates at 00:00 UTC are their own day in every workspace timezone', () => {
  const contract = active({ endDate: new Date('2026-12-31T00:00:00.000Z'), reminderDays: 0 })
  // 20:00 in New York on Dec 31 is already Jan 1 in UTC; the workspace day is Dec 31.
  const newYorkEvening = new Date('2027-01-01T01:00:00.000Z')
  assert.equal(tenantCalendarDay(newYorkEvening, 'America/New_York'), '2026-12-31')
  assert.equal(state(contract, tenantCalendarDay(newYorkEvening, 'America/New_York')), 'ending')
  // In Los Angeles it is 17:00 on Dec 31: still the end date.
  assert.equal(state(contract, tenantCalendarDay(newYorkEvening, 'America/Los_Angeles')), 'ending')
  // In Shanghai it is 09:00 on Jan 1: the end date has passed.
  assert.equal(state(contract, tenantCalendarDay(newYorkEvening, 'Asia/Shanghai')), 'ended')
  // At 23:59 in New York on Dec 31 it is still the end date; one minute later it is not.
  assert.equal(state(contract, tenantCalendarDay(new Date('2027-01-01T04:59:00.000Z'), 'America/New_York')), 'ending')
  assert.equal(state(contract, tenantCalendarDay(new Date('2027-01-01T05:00:00.000Z'), 'America/New_York')), 'ended')
  // In Auckland (UTC+13 in summer) the workspace day turns earlier.
  assert.equal(state(contract, tenantCalendarDay(new Date('2026-12-31T10:59:00.000Z'), 'Pacific/Auckland')), 'ending')
  assert.equal(state(contract, tenantCalendarDay(new Date('2026-12-31T11:00:00.000Z'), 'Pacific/Auckland')), 'ended')
})

test('every state the logic returns is a known state, and a missing day is refused', () => {
  const days = ['2025-12-01', '2026-10-02', '2026-11-01', '2026-12-01', '2026-12-31', '2027-01-01']
  const contracts = [
    { status: 'draft' }, active(), active({ endDate: null }), active({ renewal: 'automatic', noticeDays: 30 }),
    active({ renewal: 'by_agreement' }), active({ status: 'terminated', terminatedOn: '2026-06-01' }),
  ]
  for (const today of days) for (const contract of contracts) for (const renewalActivated of [false, true]) {
    assert.ok(CONTRACT_STATES.includes(state(contract, today, { renewalActivated })))
  }
  assert.throws(() => contractShownState(active(), {}), TypeError)
  assert.throws(() => contractShownState(active(), { today: '2026-13-01' }), TypeError)
})
