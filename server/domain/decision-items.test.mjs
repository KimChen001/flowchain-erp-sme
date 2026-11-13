import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFTED_DECISION_KINDS, addWorkdays, arrangeToday, closableAreas, comesBack, decisionKey, decisionSnapshot, parseDecision, planDecisionSync,
} from './decision-items.mjs'

const today = '2026-11-12' // a Thursday
const row = (kind, recordId, fields = {}) => ({ id: `${kind}:${recordId}`, kind, entityType: 'x', recordId, date: fields.date ?? null, overdueDays: fields.overdueDays ?? 0, detail: fields.detail || {} })
const decided = (kind, recordId, decision, fields = {}) => ({ id: `item-${recordId}`, activeKey: `${kind}:${recordId}`, kind, recordId, state: 'decided', decision, returnOn: fields.returnOn ?? null, snapshot: { decidedOn: fields.decidedOn ?? today, ...(fields.snapshot || {}) } })

test('the key is the kind and the record, so a moving date keeps one item', () => {
  assert.equal(decisionKey(row('reorder_now', 'ITEM-1', { date: '2026-11-12' })), 'reorder_now:ITEM-1')
  assert.equal(decisionKey(row('reorder_now', 'ITEM-1', { date: '2026-11-20' })), 'reorder_now:ITEM-1')
})

test('workdays skip the weekend', () => {
  assert.equal(addWorkdays('2026-11-12', 1), '2026-11-13')
  assert.equal(addWorkdays('2026-11-12', 3), '2026-11-17') // Thu → Fri, Mon, Tue
  assert.equal(addWorkdays('2026-11-14', 1), '2026-11-16') // Saturday → Monday
})

test('"Not now" comes back on its day, not before', () => {
  const item = decided('purchase_order_overdue', 'PO-1', 'not_now', { returnOn: '2026-11-16' })
  const current = row('purchase_order_overdue', 'PO-1', { date: '2026-11-01', overdueDays: 11 })
  assert.equal(comesBack(item, current, '2026-11-15'), false)
  assert.equal(comesBack(item, current, '2026-11-16'), true)
})

test('a chased order comes back after 3 workdays, or when its promised date changed', () => {
  const item = decided('purchase_order_overdue', 'PO-1', 'chased', { snapshot: { date: '2026-11-01' } })
  const same = row('purchase_order_overdue', 'PO-1', { date: '2026-11-01', overdueDays: 13 })
  assert.equal(comesBack(item, same, '2026-11-16'), false)
  assert.equal(comesBack(item, same, '2026-11-17'), true)
  const newDate = row('purchase_order_overdue', 'PO-1', { date: '2026-11-10', overdueDays: 2 })
  assert.equal(comesBack(item, newDate, '2026-11-13'), true)
})

test('a reorder set aside as not needed comes back only when the condition gets materially worse, or after 30 days', () => {
  const item = decided('reorder_now', 'ITEM-1', 'not_needed', { snapshot: { shortfall: 40, stockSignal: null } })
  const at = (detail) => row('reorder_now', 'ITEM-1', { date: today, detail })
  assert.equal(comesBack(item, at({ shortfall: 60, stockSignal: 'stock_below_reorder' }), '2026-11-20'), false)
  assert.equal(comesBack(item, at({ shortfall: 80 }), '2026-11-20'), true, 'the shortfall doubled')
  assert.equal(comesBack(item, at({ shortfall: 45, stockSignal: 'stock_below_safety' }), '2026-11-20'), true, 'now below safety stock')
  assert.equal(comesBack(item, at({ shortfall: 45 }), '2026-12-12'), true, '30 days passed')
})

test('an overdue order set aside comes back 7 days later in arrears, or on a new promised date', () => {
  const item = decided('purchase_order_overdue', 'PO-1', 'not_needed', { snapshot: { date: '2026-11-01', overdueDays: 11 } })
  assert.equal(comesBack(item, row('purchase_order_overdue', 'PO-1', { date: '2026-11-01', overdueDays: 17 }), '2026-11-18'), false)
  assert.equal(comesBack(item, row('purchase_order_overdue', 'PO-1', { date: '2026-11-01', overdueDays: 18 }), '2026-11-19'), true)
  assert.equal(comesBack(item, row('purchase_order_overdue', 'PO-1', { date: '2026-11-10', overdueDays: 9 }), '2026-11-19'), true)
})

test('an approved request set aside comes back after 14 days', () => {
  const item = decided('purchase_request_to_convert', 'PR-1', 'not_needed')
  const current = row('purchase_request_to_convert', 'PR-1')
  assert.equal(comesBack(item, current, '2026-11-25'), false)
  assert.equal(comesBack(item, current, '2026-11-26'), true)
})

test('a covered reorder comes back when no open request covers it, and stays when coverage is unknown', () => {
  const item = decided('reorder_now', 'ITEM-1', 'covered')
  const current = row('reorder_now', 'ITEM-1', { date: today })
  assert.equal(comesBack(item, current, today, { covered: true }), false)
  assert.equal(comesBack(item, current, today, { covered: null }), false)
  assert.equal(comesBack(item, current, today, { covered: false }), true)
})

test('sync raises new rows, reopens what came back, and closes only rows it could see', () => {
  const rows = [
    row('reorder_now', 'ITEM-1', { date: today }),
    row('purchase_order_overdue', 'PO-1', { date: '2026-11-01', overdueDays: 11 }),
  ]
  const items = [
    decided('purchase_order_overdue', 'PO-1', 'not_now', { returnOn: today }),
    { id: 'gone-open', activeKey: 'purchase_request_to_convert:PR-9', kind: 'purchase_request_to_convert', recordId: 'PR-9', state: 'open' },
    { id: 'gone-decided', activeKey: 'purchase_order_overdue:PO-8', kind: 'purchase_order_overdue', recordId: 'PO-8', state: 'decided', decision: 'chased', snapshot: {} },
    { id: 'gone-bill', activeKey: 'bill_exception:B-1', kind: 'bill_exception', recordId: 'B-1', state: 'open' },
  ]
  const plan = planDecisionSync(items, rows, { today, areas: closableAreas({ hidden: ['bills'] }) })
  assert.deepEqual(plan.create.map(decisionKey), ['reorder_now:ITEM-1'])
  assert.deepEqual(plan.reopen.map((item) => item.id), ['item-PO-1'])
  assert.deepEqual(plan.close.map(({ item, state }) => [item.id, state]), [['gone-open', 'expired'], ['gone-decided', 'resolved']])
})

test('rows a source could not read are never closed', () => {
  const areas = closableAreas({ limitations: ['today_source_unavailable:reorder_list', 'today_database_sources_unavailable'] })
  assert.equal(areas.has('inventory'), false)
  assert.equal(areas.has('contracts'), false)
  assert.equal(areas.has('purchasing'), true)
  assert.equal(closableAreas({ limitations: ['reorder_not_checked_for_warehouse_scope'] }).has('inventory'), false)
})

test('Today splits into what waits for a decision, what is set aside, and the rest', () => {
  const rows = [
    row('purchase_order_overdue', 'PO-1', { date: '2026-11-01', overdueDays: 11 }),
    row('sales_order_to_ship', 'SO-1', { date: '2026-11-05' }),
    row('reorder_now', 'ITEM-1', { date: today }),
    row('purchase_request_to_convert', 'PR-1', { date: '2026-11-20' }),
  ]
  const items = [decided('reorder_now', 'ITEM-1', 'not_needed'), { activeKey: 'purchase_order_overdue:PO-1', state: 'open' }]
  const { waiting, setAside, work } = arrangeToday(rows, items)
  assert.deepEqual(waiting.map((entry) => entry.key), ['purchase_order_overdue:PO-1', 'purchase_request_to_convert:PR-1'])
  assert.deepEqual(setAside.map((entry) => entry.key), ['reorder_now:ITEM-1'])
  assert.deepEqual(work.map(decisionKey), ['sales_order_to_ship:SO-1'])
  // A held supplier invoice has a card too (2026-11-13).
  assert.deepEqual(DRAFTED_DECISION_KINDS, ['reorder_now', 'purchase_order_overdue', 'purchase_request_to_convert', 'bill_exception'])
})

test('a decision keeps the condition it was taken on', () => {
  assert.deepEqual(decisionSnapshot(row('reorder_now', 'ITEM-1', { date: today, detail: { shortfall: 12, stockSignal: 'stock_below_safety' } }), today), {
    decidedOn: today, date: today, overdueDays: 0, shortfall: 12, stockSignal: 'stock_below_safety',
  })
})

test('decisions are checked before they are stored', () => {
  const parse = (input, kind = 'reorder_now') => parseDecision(input, { kind, today })
  assert.deepEqual(parse({ option: 'not_now', returnOn: '2026-11-13' }), { decision: 'not_now', returnOn: '2026-11-13', reasonCode: null, note: null })
  assert.throws(() => parse({ option: 'not_now', returnOn: today }), { code: 'DECISION_RETURN_DAY_INVALID' })
  assert.throws(() => parse({ option: 'not_now', returnOn: '2027-03-01' }), { code: 'DECISION_RETURN_DAY_INVALID' })
  assert.equal(parse({ option: 'not_needed', reasonCode: 'seasonal' }).reasonCode, 'seasonal')
  assert.throws(() => parse({ option: 'not_needed', reasonCode: 'because' }), { code: 'DECISION_REASON_INVALID' })
  assert.throws(() => parse({ option: 'not_needed', reasonCode: 'other' }), { code: 'DECISION_NOTE_REQUIRED' })
  assert.throws(() => parse({ option: 'not_needed', reasonCode: 'seasonal', note: 'x'.repeat(201) }), { code: 'DECISION_NOTE_TOO_LONG' })
  assert.throws(() => parse({ option: 'chased' }), { code: 'DECISION_OPTION_INVALID' })
  assert.equal(parse({ option: 'chased' }, 'purchase_order_overdue').decision, 'chased')
  // The supplier was asked about a held invoice.
  assert.equal(parse({ option: 'chased' }, 'bill_exception').decision, 'chased')
  assert.throws(() => parse({ option: 'covered' }), { code: 'DECISION_OPTION_INVALID' }, 'only the system records coverage')
  assert.deepEqual(parse({ option: 'accepted', documentType: 'purchase_order', documentIds: ['PO-9', 'PO-9', 'PO-10'] }, 'purchase_request_to_convert').documentIds, ['PO-9', 'PO-10'])
  assert.throws(() => parse({ option: 'accepted', documentType: 'invoice', documentIds: ['X'] }), { code: 'DECISION_DOCUMENT_INVALID' })
  assert.throws(() => parse({ option: 'accepted', documentType: 'purchase_order', documentIds: [] }), { code: 'DECISION_DOCUMENT_INVALID' })
})

test('waiting decisions show the earliest of each kind first, so many of one kind hide none of the others', () => {
  const day = (n) => `2026-11-${String(n).padStart(2, '0')}`
  const rows = [
    row('bill_exception', 'INV-1', { date: day(1) }),
    row('bill_exception', 'INV-2', { date: day(2) }),
    row('bill_exception', 'INV-3', { date: day(3) }),
    row('purchase_order_overdue', 'PO-1', { date: day(4) }),
    row('bill_exception', 'INV-4', { date: day(5) }),
    row('reorder_now', 'ITEM-1', { date: day(6) }),
  ]
  const { waiting } = arrangeToday(rows, [])
  assert.deepEqual(waiting.map((entry) => entry.key), ['bill_exception:INV-1', 'purchase_order_overdue:PO-1', 'reorder_now:ITEM-1', 'bill_exception:INV-2', 'bill_exception:INV-3', 'bill_exception:INV-4'])
})
