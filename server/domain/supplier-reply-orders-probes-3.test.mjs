// The third #449 review's probes, written against 9d34af4d (11/22): 60
// emails hunting a date proposed on the wrong order or line (W), 32
// ordinary replies about several orders (R) and 10 one-order replies with
// the supplier's own numbers (S). Each runs three ways: as the paste runs it
// (the supplier's orders looked up when a number is written another way;
// pasteSeveral when two or more are named), with emailRead and orderNumbers
// both empty (e0), and with emailRead empty but the supplier's orders given
// (eF). No model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, checkReplyReadingBeforeGate, cleanSupplierReply } from './supplier-reply-reading.mjs'
import { emailOrdersToRead, orderNumberVariants, orderNumbersNamed } from './supplier-reply-orders.mjs'
import { ROUND_3 } from '../../tests/ai-eval/supplier-reply/review-probes.mjs'

const { A, B, C, D, E, F, H044, H074, H110, H437, H500, L, LIST, LIST_EF, OPEN, ORDERS, R, RECEIVED, STATUS, W, item, short } = ROUND_3

const statusOf = (kase, number) => (kase.statusOverride && kase.statusOverride[number]) || STATUS[number] || 'issued'
// As the paste runs it, on the order the email is pasted on.
function asThePaste(kase, text) {
  const pasted = kase.pasted || Object.keys(kase.per || {})[0] || A
  const list = kase.supplierOrders || LIST
  const known = orderNumberVariants(text, pasted) ? list : []
  const named = orderNumbersNamed(text, pasted, known)
  if (named.length < 2) return { emailRead: [], orderNumbers: known }
  const choice = emailOrdersToRead({ named, pastedOn: pasted, openStates: OPEN, limit: 5, orders: list.map((number) => ({ number, status: statusOf(kase, number), supplier: 'S1' })) })
  return { emailRead: choice.read.filter((number) => ORDERS[number]), orderNumbers: known }
}
const MODES = ['paste', 'e0', 'eF']
function argsFor(kase, on, lines, mode) {
  const text = cleanSupplierReply(kase.email).text
  const paths = mode === 'paste' ? asThePaste(kase, text) : mode === 'e0' ? { emailRead: [], orderNumbers: [] } : { emailRead: [], orderNumbers: kase.supplierOrders || LIST }
  return { order: { ...ORDERS[on], status: 'issued' }, text, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines, flags: kase.flags || [], reason: null }, ...paths }
}
const check = (kase, on, lines, mode) => checkReplyReading(argsFor(kase, on, lines, mode))
const wrongIn = (result, kase) => result.lines.filter((line) => line.outcome === 'proposed' && (kase.bad || []).some(([ref, date]) => ref === line.ref && date === line.proposedDate)).map((line) => `${line.ref}@${line.proposedDate}`)

// Known gaps on the one-order paste, which the gate does not touch (it reads
// as on main; coordinator, 11/22): another order's number in a form the
// numbering does not see (W02 "PO No. 202611-0014:", W03 订单号：202611-0014,
// W07 a U+2010 dash, W08 "Order No.", W58 "PO#:", W59 "PO Number:"), and an
// email that names only A read on F (W57, as when pasted on the wrong order).
// Wrong on main too; followed up apart.
const ONE_ORDER_GAPS = ['W02', 'W03', 'W07', 'W08', 'W57', 'W58', 'W59']
test('third review probes: no date is ever proposed on an order or line it is not for (53 of 60 emails, three ways of reading)', () => {
  assert.equal(W.length, 60)
  for (const kase of W.filter((one) => !ONE_ORDER_GAPS.includes(one.id.split(' ')[0]))) {
    for (const mode of MODES) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})
test('third review probes: the one-order paste still misreads another order written in a form it does not see (W02, W03, W07, W08, W57, W58, W59)', { todo: 'known gap on the one-order path, as on main; followed up apart' }, () => {
  for (const kase of W.filter((one) => ONE_ORDER_GAPS.includes(one.id.split(' ')[0]))) {
    for (const mode of MODES) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})

// The final gate only adds holds: every line is as it was before the gate,
// or a line that was proposed, confirmed, held or dropped as another
// order's text is now held as several_orders with only its quote. Nothing
// proposed, dropped or moved by it.
function onlyAddsHolds(before, after) {
  if (before.lines.length !== after.lines.length || JSON.stringify(before.flags) !== JSON.stringify(after.flags)) return false
  return before.lines.every((row, at) => {
    const next = after.lines[at]
    if (JSON.stringify(row) === JSON.stringify(next)) return true
    const held = next.ref === row.ref && next.quote === row.quote && next.outcome === 'needs_you' && next.issue === 'several_orders' && next.proposedDate === null && next.readAs === null && next.readings === null && next.parts === null
    return held && (['proposed', 'confirmed', 'needs_you'].includes(row.outcome) || (row.outcome === 'dropped' && row.issue === 'other_order_text'))
  }) && (after.state === before.state || after.state === 'needs_you')
}
test('third review probes: the final gate only adds holds (60 + 42 emails, three ways of reading)', () => {
  for (const mode of MODES) {
    for (const kase of W) assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsFor(kase, kase.on, kase.lines, mode)), check(kase, kase.on, kase.lines, mode)), `${kase.id} [${mode}]`)
    for (const kase of R) {
      for (const [on, rows] of Object.entries(kase.per)) {
        const lines = rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra))
        assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsFor(kase, on, lines, mode)), check(kase, on, lines, mode)), `${kase.id} on ${short(on)} [${mode}]`)
      }
    }
  }
})

// Every correct line, read on its own order: proposed (or confirmed), or
// held for the person; never dropped and never another date. Every R reply
// is about several orders and goes to the person; only one-order S replies
// are proposed: 7 proposed and 78 held as the paste runs it (and with eF),
// 8 and 77 in e0.
function tally(mode) {
  const got = { proposed: 0, held: [], other: [] }
  for (const kase of R) {
    for (const [on, rows] of Object.entries(kase.per)) {
      const result = check(kase, on, rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra)), mode)
      for (const [ref, date] of rows) {
        const row = result.lines.find((line) => line.ref === ref)
        const id = `${kase.id.split(' ')[0]} ${short(on)} ${ref}`
        if ((row?.outcome === 'proposed' && row.proposedDate === date) || row?.outcome === 'confirmed') got.proposed += 1
        else if (row?.outcome === 'needs_you') got.held.push(id)
        else got.other.push(`${id}: ${row?.outcome}/${row?.issue}@${row?.proposedDate}`)
      }
    }
  }
  return got
}
test('third review probes: of the 85 correct lines none is dropped or given another date, three ways of reading', () => {
  for (const mode of MODES) {
    const got = tally(mode)
    assert.deepEqual(got.other, [], mode)
    assert.equal(got.proposed + got.held.length, 85, mode)
  }
})
