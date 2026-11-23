// The second #449 review's probes, written against d0691a5a (11/22): 40
// emails hunting a date proposed on the wrong order (W) and 30 ordinary,
// correct replies about several orders (R). Each runs as the paste runs it:
// cleanSupplierReply, the supplier's orders looked up when a number is
// written another way, emailRead as pasteSeveral sets it (or empty, as the
// one-order paste), then checkReplyReading with a hand-made reading. No model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, checkReplyReadingBeforeGate, cleanSupplierReply } from './supplier-reply-reading.mjs'
import { orderNumberVariants, orderNumbersNamed } from './supplier-reply-orders.mjs'
import { ROUND_2 } from '../../tests/ai-eval/supplier-reply/review-probes.mjs'

const { A, B, C, D, H044, H074, H110, H437, H500, L, ORDERS, R, RECEIVED, W, item, short, supplierOrders } = ROUND_2

function argsFor(kase, on, lines, mode) {
  const text = cleanSupplierReply(kase.email).text
  const orderNumbers = orderNumberVariants(text, on) ? supplierOrders(kase) : []
  const named = orderNumbersNamed(text, on, orderNumbers)
  const emailRead = mode === 'empty' || named.length < 2 ? [] : [on, ...named.filter((number) => number !== on && ORDERS[number])]
  return { order: ORDERS[on], text, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines, flags: kase.flags || [], reason: null }, emailRead, orderNumbers }
}
const check = (kase, on, lines, mode) => checkReplyReading(argsFor(kase, on, lines, mode))
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
test('second review probes: the final gate only adds holds (40 + 30 emails, both ways of reading)', () => {
  for (const mode of ['paste', 'empty']) {
    for (const kase of W) assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsFor(kase, kase.on, kase.lines, mode)), check(kase, kase.on, kase.lines, mode)), `${kase.id} [${mode}]`)
    for (const kase of R) {
      for (const [on, rows] of Object.entries(kase.per)) {
        const lines = rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra))
        assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsFor(kase, on, lines, mode)), check(kase, on, lines, mode)), `${kase.id} on ${short(on)} [${mode}]`)
      }
    }
  }
})
const wrongIn = (result, kase) => result.lines.filter((line) => line.outcome === 'proposed' && (kase.bad || []).some(([ref, date]) => ref === line.ref && date === line.proposedDate)).map((line) => `${line.ref}@${line.proposedDate}`)

test('second review probes: no date is ever proposed on an order it is not for (40 emails, both ways of reading)', () => {
  assert.equal(W.length, 40)
  for (const kase of W) {
    for (const mode of ['paste', 'empty']) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})
// A later sentence that gives earlier lines to another order ("Sorry, that
// line is for B, not A.", "Correction: the above is for B."): every line of
// the email goes to the person, on every order, none dropped (coordinator,
// 11/22; wrong on 6fa2d753).
test('second review probes: a correction that hands earlier lines to another order holds every line (W23, W24)', () => {
  for (const kase of W.filter((one) => ['W23', 'W24'].includes(one.id.split(' ')[0]))) {
    for (const mode of ['paste', 'empty']) {
      for (const on of [A, B]) {
        const lines = check(kase, on, [L('L2', '2026-12-03', `${A}: ${H110} ships on 3 December.`)], mode).lines
        assert.deepEqual(lines.map((line) => [line.ref, line.outcome, line.issue]), [['L2', 'needs_you', 'several_orders']], `${kase.id} on ${short(on)} [${mode}]`)
      }
    }
  }
})

// Every correct line, read on its own order, both ways: an email about
// several orders goes to the person; R27-R30 name one of our orders (the
// rest are the supplier's own numbers) and are read as one order, proposed
// as on main. Never dropped, never another date.
test('second review probes: of the 60 correct lines, 53 go to the person and the 7 of one-order replies are proposed, none dropped (both ways of reading)', () => {
  assert.equal(R.length, 30)
  for (const mode of ['paste', 'empty']) {
    const other = []
    let held = 0
    let proposed = 0
    for (const kase of R) {
      for (const [on, rows] of Object.entries(kase.per)) {
        const result = check(kase, on, rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra)), mode)
        for (const [ref] of rows) {
          const row = result.lines.find((line) => line.ref === ref)
          const oneOrder = ['R27', 'R28', 'R29', 'R30'].includes(kase.id.split(' ')[0])
          if (!oneOrder && row?.outcome === 'needs_you') held += 1
          else if (oneOrder && row?.outcome === 'proposed') proposed += 1
          else other.push(`${kase.id.split(' ')[0]} ${short(on)} ${ref}: ${row?.outcome}/${row?.issue}`)
        }
      }
    }
    assert.deepEqual([held, proposed, other], [53, 7, []], mode)
  }
})
