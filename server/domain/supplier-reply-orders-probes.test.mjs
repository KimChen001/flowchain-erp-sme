// The first #449 review's probes of de3e6fe0 (64 emails about several orders, from
// emailParts through checkReplyReading with hand-made readings; written by
// an independent review, 11/22) and its known-number duplicate check, kept
// as tests. No model.
//   W  a date that must never be proposed on the order checked
//   R  a correct reply: its date is proposed or goes to the person, never dropped
//   X  how parts behave around a passing mention
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, checkReplyReadingBeforeGate } from './supplier-reply-reading.mjs'
import { emailParts, orderNumbersNamed } from './supplier-reply-orders.mjs'
import { ROUND_1 } from '../../tests/ai-eval/supplier-reply/review-probes.mjs'

const { A, B, C, H044, H074, H110, H437, L, ORDERS, RECEIVED, case12, cases, item, zh12 } = ROUND_1

const argsOf = (kase) => ({ order: kase.order || ORDERS[kase.on], text: kase.email, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines: kase.lines, flags: kase.flags || [], reason: null }, emailRead: kase.read ?? [A, B] })
const check = (kase) => checkReplyReading(argsOf(kase))

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
test('review probes: the final gate only adds holds (64 emails)', () => {
  for (const kase of cases) assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsOf(kase)), check(kase)), kase.id)
})

test('review probes: no date is ever proposed on an order it is not for (64 emails)', () => {
  assert.equal(cases.length, 64)
  for (const kase of cases) {
    const wrong = check(kase).lines.filter((line) => line.outcome === 'proposed' && (kase.bad || []).some(([ref, date]) => ref === line.ref && date === line.proposedDate))
    assert.deepEqual(wrong.map((line) => `${line.ref}@${line.proposedDate}`), [], kase.id)
  }
})

// Every email here is read on two orders (emailRead [A, B]), the
// several-order path: every correct date goes to the person with only its
// quote (several_orders), none is proposed and none dropped.
test('review probes: every correct date goes to the person on the several-order path, never dropped (22 correct replies)', () => {
  assert.equal(cases.filter((one) => /^R\d/.test(one.id)).length, 22)
  for (const kase of cases.filter((one) => one.good)) {
    const lines = check(kase).lines
    for (const [ref] of kase.good) {
      const row = lines.find((line) => line.ref === ref)
      assert.deepEqual([row?.outcome, row?.issue, row?.proposedDate, row?.parts], ['needs_you', 'several_orders', null, null], kase.id)
    }
  }
})

test('the order read on, also in the known list, is matched once: its number written another way still resolves (review dup-known, W25, W35, W37)', () => {
  const email = `${A}:\nHOUSEHOLD_2_110 goes with the PO 14 goods on 8 December.`
  for (const [on, known] of [[B, [A, B]], [B, [A]], [A, [A, B]], [A, [B]]]) {
    assert.deepEqual(orderNumbersNamed(email, on, known), [A, B], `${on} ${known}`)
    assert.notEqual(emailParts(email, on, known), null, `${on} ${known}`)
  }
})
