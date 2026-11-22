// An email about several purchase orders: the numbers it names, the part of
// the text each order owns, and which named orders are read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emailOrdersToRead, emailParts, orderNumberPrefix, orderNumbersNamed } from './supplier-reply-orders.mjs'

const A = 'PO-202611-0012'
const B = 'PO-202611-0013'
const C = 'PO-202611-0014'
// Each run's owners, with its text folded to one line. Text as read:
// full-width forms folded (NFKC), so ： is : and ； is ;.
const runsOf = (text, number = A) => emailParts(text, number)?.runs.map((run) => [run.owners.join('+') || '-', run.text.replace(/\s+/g, ' ').trim()]).filter(([, value]) => value)
const folded = (rows) => rows.map(([owners, value]) => [owners, value.normalize('NFKC')])

test('only numbers in the order\'s own numbering count, each once, first mention first', () => {
  assert.equal(orderNumberPrefix(A), 'PO')
  assert.equal(orderNumberPrefix('PO-0012'), null)
  assert.equal(orderNumberPrefix('legacy order 12'), null)
  assert.deepEqual(orderNumbersNamed(`Re ${B}: ${A} ships first, then ${b(B)}. Invoice INV-202611-0003, item SKU-1040.`, A), [B, A])
  // Full-width and lower-case forms are the same number.
  assert.deepEqual(orderNumbersNamed('ＰＯ－２０２６１１－００１３ and po-202611-0012', A), [B, A])
  // An order outside the numbering is read as before: no numbers, no parts.
  assert.deepEqual(orderNumbersNamed(`${A} and ${B}`, 'PO-12'), [])
  assert.equal(emailParts(`${A} and ${B}`, 'PO-12'), null)
})
const b = (value) => value.toLowerCase()

test('fewer than two orders named: no parts, the reply is read as one order', () => {
  assert.equal(emailParts(`Hi,\n${A} ships on 4 December.\nThanks`, A), null)
  assert.equal(emailParts(`Hi,\n${B} ships on 4 December.\nThanks`, A), null)
  assert.equal(emailParts('Hi, everything ships on 4 December.', A), null)
})

test('a paragraph or a line per order: each order owns its text until the next order; a greeting and a sign-off own nothing', () => {
  assert.deepEqual(runsOf(`Hi Daniel,\n\n${A}: the brackets ship on 4 December.\nThe hinges follow on 8 December.\n\n${B}: all of it ships on 10 December.\n\nRegards,\nPat`), [
    ['-', 'Hi Daniel,'],
    [A, `${A}: the brackets ship on 4 December. The hinges follow on 8 December.`],
    [B, `${B}: all of it ships on 10 December.`],
    ['-', 'Regards, Pat'],
  ])
  assert.deepEqual(runsOf(`${A} - brackets: 4 Dec\n${B} - springs: 10 Dec\n${C} - hinges: 12 Dec`), [
    [A, `${A} - brackets: 4 Dec`], [B, `${B} - springs: 10 Dec`], [C, `${C} - hinges: 12 Dec`],
  ])
  // Two orders in one line, a sentence each.
  assert.deepEqual(runsOf(`For ${A} the brackets ship 4 Dec; for ${B} the springs ship 10 Dec.`), [[A, `For ${A} the brackets ship 4 Dec;`], [B, `for ${B} the springs ship 10 Dec.`]])
  // Chinese: 。and ； end sentences.
  assert.deepEqual(runsOf(`您好：\n${A}（六款）：整张单12月1日发货；\n${B}：84347 改到12月7日，其余还是11月30日。\n陈经理`), folded([
    ['-', '您好：'], [A, `${A}（六款）：整张单12月1日发货；`], [B, `${B}：84347 改到12月7日，其余还是11月30日。 陈经理`],
  ]))
})

test('a line that only names the order keeps its part over a blank line; any other blank line ends the part', () => {
  assert.deepEqual(runsOf(`${A}:\n\n- brackets 4 Dec\n- hinges 8 Dec\n\nWe are closed 24 to 26 December.\n\n关于订单 ${B}：\n\n全部12月10日发货。`), folded([
    [A, `${A}: - brackets 4 Dec - hinges 8 Dec`],
    ['-', 'We are closed 24 to 26 December.'],
    [B, `关于订单 ${B}： 全部12月10日发货。`],
  ]))
})

test('a sentence that names two orders belongs to both together, and what follows it to no order until the next number', () => {
  assert.deepEqual(runsOf(`${A} and ${B} both ship on 4 December.\nThe springs follow later.\n${C} ships on 9 December.`), [
    [`${A}+${B}`, `${A} and ${B} both ship on 4 December.`],
    ['-', 'The springs follow later.'],
    [C, `${C} ships on 9 December.`],
  ])
})

test('which named orders are read: the pasted order first, then open orders of its supplier, at most five; the rest listed with why', () => {
  const open = ['issued', 'partially_received']
  const orders = [
    { number: A, status: 'issued', supplier: 'SUP-1' },
    { number: B, status: 'partially_received', supplier: 'SUP-1' },
    { number: C, status: 'closed', supplier: 'SUP-1' },
    { number: 'PO-202611-0015', status: 'issued', supplier: 'SUP-2' },
    { number: 'PO-202611-0016', status: 'issued', supplier: 'SUP-1' },
  ]
  const named = [B, C, 'PO-202611-0015', 'PO-202611-0099', A, 'PO-202611-0016']
  assert.deepEqual(emailOrdersToRead({ named, pastedOn: A, orders, openStates: open }), {
    read: [A, B, 'PO-202611-0016'],
    notRead: [{ number: C, why: 'closed' }, { number: 'PO-202611-0015', why: 'other_supplier' }, { number: 'PO-202611-0099', why: 'unknown' }],
  })
  // At most `limit` in all, the pasted order counted.
  assert.deepEqual(emailOrdersToRead({ named, pastedOn: A, orders, openStates: open, limit: 2 }).notRead.at(-1), { number: 'PO-202611-0016', why: 'over_limit' })
  // Pasted on an order the email does not name: still read, first.
  assert.deepEqual(emailOrdersToRead({ named: [B, 'PO-202611-0016'], pastedOn: A, orders, openStates: open }).read, [A, B, 'PO-202611-0016'])
  // An emailed reply: the given supplier, or the first named open order's.
  assert.deepEqual(emailOrdersToRead({ named: ['PO-202611-0015', B, A], orders, openStates: open }), { read: ['PO-202611-0015'], notRead: [{ number: B, why: 'other_supplier' }, { number: A, why: 'other_supplier' }] })
  assert.deepEqual(emailOrdersToRead({ named: ['PO-202611-0015', B, A], orders, openStates: open, supplier: 'SUP-1' }).read, [B, A])
  // A pasted order with no supplier reads no other order.
  assert.deepEqual(emailOrdersToRead({ named: [A, B], pastedOn: A, orders: [{ number: A, status: 'issued', supplier: null }, orders[1]], openStates: open }).notRead, [{ number: B, why: 'other_supplier' }])
})
