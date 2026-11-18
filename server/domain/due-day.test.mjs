import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dueCalendarDay, isPastDueOn, workspaceDueToday } from './due-day.mjs'
import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import { buildProcurementFollowups, buildProcurementSummary } from './procurement-read-model.mjs'

// Design audit L6-23: the review-actions queue read "3月4日" as 2026 and
// judged overdue at UTC midnight. These cases use 2027 and 2028 and time
// zones whose calendar day differs from UTC's at the chosen moment.

test('a month and day without a year takes the year nearest the reference day', () => {
  assert.equal(dueCalendarDay('11月20日', '2027-11-17'), '2027-11-20')
  assert.equal(dueCalendarDay('1月5日', '2027-12-28'), '2028-01-05')
  assert.equal(dueCalendarDay('ETA 12月20日', '2028-01-03'), '2027-12-20')
  assert.equal(dueCalendarDay('2027-03-04T23:30:00-05:00', '2028-01-03'), '2027-03-04')
  assert.equal(dueCalendarDay('2027-02-30', '2027-01-01'), '')
  assert.equal(dueCalendarDay('待确认', '2027-01-01'), '')
  assert.equal(dueCalendarDay('3月4日', ''), '')
})

test("the workspace's today follows its time zone, not UTC", () => {
  // 03:00 UTC on 5 March 2027 is still 4 March in New York.
  assert.equal(workspaceDueToday({ now: new Date('2027-03-05T03:00:00Z'), timeZone: 'America/New_York' }), '2027-03-04')
  assert.equal(workspaceDueToday({ now: new Date('2027-03-05T03:00:00Z'), timeZone: 'UTC' }), '2027-03-05')
  // 17:00 UTC on 4 March 2027 is already 5 March in Shanghai.
  assert.equal(workspaceDueToday({ now: '2027-03-04T17:00:00Z', timeZone: 'Asia/Shanghai' }), '2027-03-05')
  assert.equal(isPastDueOn('3月4日', '2027-03-04'), false)
  assert.equal(isPastDueOn('3月4日', '2027-03-05'), true)
  assert.equal(isPastDueOn('12月30日', '2028-01-02'), true)
  assert.equal(isPastDueOn('1月5日', '2027-12-28'), false)
  assert.equal(isPastDueOn('', '2027-12-28'), false)
})

const openPo = {
  purchaseOrders: [{
    id: 'PO-L623',
    supplierId: 'SUP-ATLAS',
    supplierName: 'Atlas Industrial Supply',
    status: '已发出',
    totalOrderedQty: 10,
    totalReceivedQty: 0,
    eta: '3月4日',
    lines: [{ poLineId: 'L1', sku: 'SKU-L623', quantityOrdered: 10, quantityReceived: 0 }],
  }],
  suppliers: [{ id: 'SUP-ATLAS', name: 'Atlas Industrial Supply' }],
}

test('the control tower judges an ETA on the workspace day', () => {
  const poItem = (options) => buildOperationsControlTowerV2(openPo, options).items.find((item) => item.id === 'po-unreceived-PO-L623')
  const lateNight = new Date('2027-03-05T03:00:00Z')
  assert.doesNotMatch(poItem({ now: lateNight, timeZone: 'America/New_York' }).reason, /ETA 已过/)
  assert.match(poItem({ now: lateNight, timeZone: 'UTC' }).reason, /ETA 已过/)
  const shanghaiMorning = new Date('2027-03-04T17:00:00Z')
  assert.match(poItem({ now: shanghaiMorning, timeZone: 'Asia/Shanghai' }).reason, /ETA 已过/)
  assert.doesNotMatch(poItem({ now: shanghaiMorning, timeZone: 'UTC' }).reason, /ETA 已过/)
})

test('the assistant contract judges an ETA on the workspace day', () => {
  const severity = (options) => buildAiResponseContractV2(openPo, { question: '哪些PO还没收货' }, options).cards[0].data.keyEvidence[0].severity
  const lateNight = new Date('2027-03-05T03:00:00Z')
  assert.equal(severity({ now: lateNight, timeZone: 'America/New_York' }), 'warning')
  assert.equal(severity({ now: lateNight, timeZone: 'UTC' }), 'risk')
})

// Found alongside L6-23: the procurement follow-ups read the same dates the same way.
test('procurement follow-ups judge an expected date on the workspace day, with its year from that day', () => {
  const overdueIds = (data, options) => buildProcurementFollowups(data, options).filter((row) => row.type === 'overdue_po').map((row) => row.documentId)
  const march = { purchaseOrders: [{ po: 'PO-FU-MARCH', status: '已发出', supplier: 'Atlas Industrial Supply', eta: '3月4日', items: 10, received: 0 }] }
  assert.deepEqual(overdueIds(march, { now: '2027-03-05T03:00:00Z', timeZone: 'America/New_York' }), [])
  assert.deepEqual(overdueIds(march, { now: '2027-03-05T03:00:00Z', timeZone: 'UTC' }), ['PO-FU-MARCH'])
  assert.equal(buildProcurementSummary(march, { now: '2027-03-05T03:00:00Z', timeZone: 'America/New_York' }).followupCount, 0)
  const december = { purchaseOrders: [{ po: 'PO-FU-DEC', status: '已发出', supplier: 'Atlas Industrial Supply', eta: '12月20日', items: 10, received: 0 }] }
  assert.deepEqual(overdueIds(december, { now: '2028-01-03T12:00:00Z', timeZone: 'Asia/Shanghai' }), ['PO-FU-DEC'])
  const january = { purchaseOrders: [{ po: 'PO-FU-JAN', status: '已发出', supplier: 'Atlas Industrial Supply', eta: '1月5日', items: 10, received: 0 }] }
  assert.deepEqual(overdueIds(january, { now: '2027-12-28T12:00:00Z', timeZone: 'Asia/Shanghai' }), [])
})

test('the review-actions and data-quality routes pass the workspace time zone', () => {
  for (const file of ['review-first-action-workflow.routes.mjs', 'data-access-quality.routes.mjs']) {
    const source = fs.readFileSync(new URL(`../routes/${file}`, import.meta.url), 'utf8')
    assert.match(source, /\{ timeZone: await readTenantTimezone\(ctx\) \}/, file)
  }
})

test('the procurement follow-up and summary routes pass the workspace time zone', () => {
  const source = fs.readFileSync(new URL('../routes/procurement-read.routes.mjs', import.meta.url), 'utf8')
  assert.equal(source.split('timeZone: await readTenantTimezone(ctx)').length - 1, 2)
})
