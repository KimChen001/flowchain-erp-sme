// The fourth #449 review's probes, written against 9a739ea3 (11/22): 67
// emails hunting a date proposed on the wrong order or line (W) and 30
// ordinary correct replies about several orders (R). Each runs four ways,
// as the review ran them: P (as the paste: the supplier's orders looked up
// when a number is written another way; pasteSeveral when two or more are
// named), PL (P with the supplier's orders always given), E0 (emailRead and
// orderNumbers empty) and EF (emailRead empty, the supplier's orders
// given). No model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, cleanSupplierReply } from './supplier-reply-reading.mjs'
import { emailOrdersToRead, orderNumberVariants, orderNumbersNamed } from './supplier-reply-orders.mjs'
import { ROUND_4 } from '../../tests/ai-eval/supplier-reply/review-probes.mjs'

const { A, L, LIST, ORDERS, R, RECEIVED, STATUS, W } = ROUND_4
const OPEN = ['issued', 'partially_received']
const MODES = ['P', 'PL', 'E0', 'EF']

function pathFor(kase, text, mode) {
  const pasted = kase.pasted || A
  const list = kase.list || LIST
  if (mode === 'E0') return { emailRead: [], orderNumbers: [], read: true }
  if (mode === 'EF') return { emailRead: [], orderNumbers: list, read: true }
  const known = mode === 'PL' || orderNumberVariants(text, pasted) ? list : []
  const named = orderNumbersNamed(text, pasted, known)
  if (named.length < 2) return { emailRead: [], orderNumbers: known, read: kase.on === pasted }
  const choice = emailOrdersToRead({ named, pastedOn: pasted, openStates: OPEN, limit: 5, orders: list.map((number) => ({ number, status: STATUS[number] || 'issued', supplier: 'S1' })) })
  const emailRead = choice.read.filter((number) => ORDERS[number])
  return { emailRead, orderNumbers: known, read: emailRead.includes(kase.on) }
}
function check(kase, on, lines, mode) {
  const text = cleanSupplierReply(kase.email).text
  const path = pathFor({ ...kase, on }, text, mode)
  return checkReplyReading({ order: { ...ORDERS[on], status: 'issued' }, text, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines, flags: kase.flags || [], reason: null }, emailRead: path.emailRead, orderNumbers: path.orderNumbers })
}
const wrongIn = (result, bad) => result.lines.filter((line) => line.outcome === 'proposed' && bad.some(([ref, date]) => ref === line.ref && date === line.proposedDate)).map((line) => `${line.ref}@${line.proposedDate}`)

test('fourth review probes: no date is ever proposed on an order or line it is not for (67 emails, four ways of reading)', () => {
  assert.equal(W.length, 67)
  const wrong = []
  for (const kase of W) for (const mode of MODES) if (wrongIn(check(kase, kase.on, kase.lines, mode), kase.bad).length) wrong.push(`${kase.id.split(' ')[0]} [${mode}]`)
  assert.deepEqual(wrong, [])
})

// Every correct line, read on its own order, four ways: proposed (or
// confirmed), or held for the person; never dropped, never another date.
// Every reply here is about several orders, so on the several-order path
// all are held; a reply read as one order (none here) would be proposed.
function tally(mode) {
  const got = { proposed: 0, held: 0, other: [] }
  for (const kase of R) {
    for (const [on, rows] of Object.entries(kase.per)) {
      const k = { ...kase, pasted: Object.keys(kase.per)[0] }
      const result = check(k, on, rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra)), mode)
      for (const [ref, date] of rows) {
        const row = result.lines.find((line) => line.ref === ref)
        if ((row?.outcome === 'proposed' && row.proposedDate === date) || row?.outcome === 'confirmed') got.proposed += 1
        else if (row?.outcome === 'needs_you') got.held += 1
        else got.other.push(`${kase.id.split(' ')[0]} ${on} ${ref}: ${row?.outcome}/${row?.issue}@${row?.proposedDate}`)
      }
    }
  }
  return got
}
test('fourth review probes: all 69 correct lines go to the person, none dropped or given another date (30 replies, four ways of reading)', () => {
  assert.equal(R.length, 30)
  for (const mode of MODES) {
    const got = tally(mode)
    assert.deepEqual([got.proposed, got.held, got.other], [0, 69, []], mode)
  }
})
