// The several-order path never proposes (fourth #449 review; coordinator,
// 11/22). Every email of the four reviews (W and R, 389 in all) is read on
// every order it carries, three ways: as pasteSeveral reads it (emailRead
// the orders named, the supplier's orders given), with only the supplier's
// orders, and with nothing. Wherever the check takes the several-order path
// (the email splits into parts, or it is read on more than one order), no
// line may be proposed or confirmed, and none dropped as another order's
// text; every such line carries only its quote. On the one-order path, the
// other-order-number gate (the W02-type gap, 11/23) may only add holds; see
// the second test. No model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, checkReplyReadingBeforeGate, cleanSupplierReply } from '../../../server/domain/supplier-reply-reading.mjs'
import { emailParts, orderNumbersNamed, otherOrderNumberWritten } from '../../../server/domain/supplier-reply-orders.mjs'
import { ROUND_1, ROUND_2, ROUND_3, ROUND_4 } from './review-probes.mjs'
import { SUPPLIER_REPLY_CASES } from './cases.mjs'
import { HELD_OUT_CASES } from './held-out-cases.mjs'
import { HELD_OUT_2_CASES } from './held-out-2-cases.mjs'

// Each round's emails as { email, on, lines, flags, orders, list }.
function emailsOf(round) {
  const list = round.LIST || Object.keys(round.ORDERS)
  const out = []
  for (const kase of round.cases || round.W) out.push({ id: kase.id, email: kase.email, on: kase.on, lines: kase.lines, flags: kase.flags, order: kase.order, orders: round.ORDERS, list: kase.list || kase.supplierOrders || list })
  for (const kase of round.R || []) {
    for (const [on, rows] of Object.entries(kase.per)) out.push({ id: kase.id, email: kase.email, on, lines: rows.map(([ref, date, quote, extra]) => round.L(ref, date, quote, extra)), flags: kase.flags, orders: round.ORDERS, list: kase.supplierOrders || kase.list || list })
  }
  return out
}
// The fifth review's shape: one line quoted twice, from this order's part
// and from another's, or twice from another's.
const { A, B, ORDERS, LIST, RECEIVED, L, H044, H074, H110 } = ROUND_4
const two = `${A}:\n${H110} ships on 8 December.\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.`
const TWICE = {
  ORDERS, LIST, RECEIVED, L,
  W: [
    { id: 'T01 L1 from its own part and from A\'s, on B', email: two, on: B, lines: [L('L1', '2026-12-05', `${H044} ships on 5 December.`), L('L1', '2026-12-08', `${H110} ships on 8 December.`)] },
    { id: 'T02 L2 twice from A\'s part, on B', email: two, on: B, lines: [L('L2', '2026-12-08', `${H110} ships on 8 December.`), L('L2', '2026-12-03', `${H074} ships on 3 December.`)] },
    { id: 'T03 L1 from A\'s part, then from its own, on B', email: two, on: B, lines: [L('L1', '2026-12-08', `${H110} ships on 8 December.`), L('L1', '2026-12-05', `${H044} ships on 5 December.`)] },
  ],
}
const ROUNDS = { 1: ROUND_1, 2: ROUND_2, 3: ROUND_3, 4: ROUND_4, 'five (one line quoted twice)': TWICE }

test('on the several-order path no line is ever proposed, confirmed or dropped as another order\'s text, and each line has one question, in all the reviews\' emails', () => {
  let several = 0
  let single = 0
  let proposedOnSingle = 0
  for (const [name, round] of Object.entries(ROUNDS)) {
    for (const one of emailsOf(round)) {
      const text = cleanSupplierReply(one.email).text
      const named = orderNumbersNamed(text, one.on, one.list).filter((number) => one.orders[number])
      for (const [way, emailRead, orderNumbers] of [['paste', named.length >= 2 ? [one.on, ...named.filter((number) => number !== one.on)] : [], one.list], ['list', [], one.list], ['nothing', [], []]]) {
        const order = one.order || { ...one.orders[one.on], status: 'issued' }
        const result = checkReplyReading({ order, text, receivedOn: round.RECEIVED, reading: { replyKind: 'dates', lines: one.lines, flags: one.flags || [], reason: null }, emailRead, orderNumbers })
        const candidates = (orderNumbers.length ? orderNumbers : emailRead).map((number) => number.toUpperCase())
        const onSeveralPath = emailParts(text, one.on, candidates) !== null || emailRead.length >= 2
        if (!onSeveralPath) {
          single += 1
          if (result.lines.some((line) => line.outcome === 'proposed')) proposedOnSingle += 1
          continue
        }
        several += 1
        const at = `round ${name} ${one.id} on ${one.on} [${way}]`
        for (const line of result.lines) {
          assert.notEqual(line.outcome, 'proposed', at)
          assert.notEqual(line.outcome, 'confirmed', at)
          assert.ok(!(line.outcome === 'dropped' && line.issue === 'other_order_text'), at)
          if (line.outcome === 'needs_you') assert.deepEqual([line.issue, line.proposedDate, line.readAs, line.readings, line.parts], ['several_orders', null, null, null, null], at)
        }
        // One question per line.
        const held = result.lines.filter((line) => line.outcome === 'needs_you').map((line) => line.ref)
        assert.equal(new Set(held).size, held.length, at)
      }
    }
  }
  // Not vacuous: most checks take the several-order path, and the one-order
  // path still proposes.
  assert.ok(several > 900, `${several} checks on the several-order path`)
  assert.ok(single > 20 && proposedOnSingle > 10, `${single} one-order checks, ${proposedOnSingle} with a proposal`)
})

// The one-order path's gate (other_order_number; the W02-type gap,
// coordinator 11/23) only adds holds: against the check before the gates,
// every line is unchanged, or a line that was proposed, confirmed or for the
// person is now for the person with only its quote. Nothing that was for the
// person or dropped becomes a proposal, nothing is dropped or moved. Run on
// every one-order check of the reviews' emails (three ways) and on the
// cases of the 46, held-out 1 and held-out 2 with perfect readings and with
// each expected line's date read as another day.
function onlyAddsOtherOrderHolds(before, after) {
  if (before.lines.length !== after.lines.length || JSON.stringify(before.flags) !== JSON.stringify(after.flags)) return false
  return before.lines.every((row, at) => {
    const next = after.lines[at]
    if (JSON.stringify(row) === JSON.stringify(next)) return true
    const held = next.ref === row.ref && next.quote === row.quote && next.outcome === 'needs_you' && next.issue === 'other_order_number' && next.proposedDate === null && next.readAs === null && next.readings === null && next.parts === null
    return held && ['proposed', 'confirmed', 'needs_you'].includes(row.outcome)
  })
}
const shiftDay = (date) => {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().slice(0, 10)
}
test('on the one-order path the other-order-number gate only adds holds, and an email writing another order\'s number in an unseen form gets no one-click date', () => {
  let checks = 0
  let gated = 0
  let proposedUngated = 0
  const run = (at, args) => {
    const before = checkReplyReadingBeforeGate(args)
    const after = checkReplyReading(args)
    assert.ok(onlyAddsOtherOrderHolds(before, after), at)
    checks += 1
    if (otherOrderNumberWritten(args.text, args.order.number)) {
      gated += 1
      for (const line of after.lines) assert.ok(!['proposed', 'confirmed'].includes(line.outcome), at)
    } else if (after.lines.some((line) => line.outcome === 'proposed')) proposedUngated += 1
  }
  for (const [name, round] of Object.entries(ROUNDS)) {
    for (const one of emailsOf(round)) {
      const text = cleanSupplierReply(one.email).text
      const named = orderNumbersNamed(text, one.on, one.list).filter((number) => one.orders[number])
      for (const [way, emailRead, orderNumbers] of [['paste', named.length >= 2 ? [one.on, ...named.filter((number) => number !== one.on)] : [], one.list], ['list', [], one.list], ['nothing', [], []]]) {
        const candidates = (orderNumbers.length ? orderNumbers : emailRead).map((number) => number.toUpperCase())
        if (emailParts(text, one.on, candidates) !== null || emailRead.length >= 2) continue
        const order = one.order || { ...one.orders[one.on], status: 'issued' }
        run(`round ${name} ${one.id} on ${one.on} [${way}]`, { order, text, receivedOn: round.RECEIVED, reading: { replyKind: 'dates', lines: one.lines, flags: one.flags || [], reason: null }, emailRead, orderNumbers })
      }
    }
  }
  for (const kase of [...SUPPLIER_REPLY_CASES, ...HELD_OUT_CASES, ...HELD_OUT_2_CASES]) {
    const text = cleanSupplierReply(kase.replyText).text
    const want = kase.expected.lines.filter((line) => line.outcome === 'proposed' && line.proposedDate && line.quoteIncludes)
    // Cases about several orders take the several-order path (tested above).
    if (!want.length || emailParts(text, kase.order.number, []) !== null) continue
    for (const [way, dateOf] of [['perfect', (line) => line.proposedDate], ['a day off', (line) => shiftDay(line.proposedDate)]]) {
      const lines = want.map((line) => ({ line: line.ref, date: dateOf(line), quote: line.quoteIncludes, dateKind: line.dateKind || 'stated' }))
      run(`${kase.id} [${way}]`, { order: kase.order, text, receivedOn: kase.replyDate, reading: { replyKind: 'dates', lines, flags: [], reason: null } })
    }
  }
  // The second #461 review's forms, on round 3's order A (PO-202611-0021):
  // another order's number after A's own block holds every line; a number
  // that is not another order's leaves A's date proposed.
  const { A: onA, H074, H110, H437, L: line } = ROUND_3
  const three = [line('L1', '2026-12-03', `${H074} ships on 3 December.`), line('L2', '2026-12-09', `${H110} ships on 9 December.`), line('L3', '2026-12-10', `${H437} ships on 10 December.`)]
  const orderA = { ...ROUND_3.ORDERS[onA], status: 'issued' }
  let notOrders = 0
  for (const form of ['PO-2026-11-0014', 'PO 2026/11/0014', 'PO 2026 11 0014', 'PO2026110014', 'PO 202611-14', 'P.O. 14', 'P/O 14', 'POs 21 & 14', '<b>PO&nbsp;14</b>', '_PO 14_', 'PO No. 202611-0014', '订单号：202611-0014', 'PO号：0014']) {
    const text = cleanSupplierReply(`Hi Kim,\n${onA}:\n${H074} ships on 3 December.\n${form}:\n${H110} ships on 9 December.\n${H437} ships on 10 December.`).text
    for (const [way, orderNumbers] of [['list', ROUND_3.LIST], ['nothing', []]]) {
      if (emailParts(text, onA, orderNumbers) !== null) continue
      const at = `review form ${JSON.stringify(form)} [${way}]`
      assert.ok(otherOrderNumberWritten(text, onA), at)
      run(at, { order: orderA, text, receivedOn: ROUND_3.RECEIVED, reading: { replyKind: 'dates', lines: three, flags: [], reason: null }, emailRead: [], orderNumbers })
    }
  }
  for (const extra of ['送货单号：202611-0102。', '物流单号 202611-0102。', 'Sales order 202611-0033 refers.', 'Our order no. 202611-0033 refers.', 'Packing list 202611-0102 attached.', 'PO 30% deposit received.', 'PO 1,200 pcs packed.', 'PO 2nd shipment.', 'PO 18 Nov received.', 'PO 3款产品均已备好。', 'PO 2026 pricing holds.', 'P.O. 834, Lombard, IL 60148-0834', 'Shanghai 201203 021-5080 1234']) {
    const text = cleanSupplierReply(`Hi Kim,\n${onA}: ${H074} ships on 3 December.\n${extra}`).text
    const at = `not another order ${JSON.stringify(extra)}`
    assert.equal(otherOrderNumberWritten(text, onA), null, at)
    // Some take the several-order path as on main (PO 30% reads as order
    // 0030 there); that path is not this gate's.
    if (emailParts(text, onA, ROUND_3.LIST) !== null) continue
    notOrders += 1
    const args = { order: orderA, text, receivedOn: ROUND_3.RECEIVED, reading: { replyKind: 'dates', lines: [three[0]], flags: [], reason: null }, emailRead: [], orderNumbers: ROUND_3.LIST }
    run(at, args)
    assert.deepEqual(checkReplyReading(args).lines.map((row) => [row.outcome, row.proposedDate]), [['proposed', '2026-12-03']], at)
  }
  assert.ok(notOrders >= 7, `${notOrders} number words that are not another order's, on the one-order path`)
  // Not vacuous: the W02-type emails are gated, and the rest still proposes.
  assert.ok(gated >= 21, `${gated} checks gated`)
  assert.ok(checks >= 130 && proposedUngated >= 60, `${checks} one-order checks, ${proposedUngated} ungated with a proposal`)
})
