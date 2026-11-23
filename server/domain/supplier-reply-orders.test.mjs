// An email about several purchase orders: the numbers it names, the part of
// the text each order owns, and which named orders are read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emailOrdersToRead, emailParts, knownOrderSequenceWritten, orderNumberPrefix, orderNumbersNamed, orderSequenceMentions, otherOrderNumberWritten } from './supplier-reply-orders.mjs'

const A = 'PO-202611-0012'
const B = 'PO-202611-0013'
const C = 'PO-202611-0014'
// Each run's owners, with its text folded to one line. Text as read:
// full-width forms folded (NFKC), so ： is : and ； is ;.
const runsOf = (text, number = A, known = []) => emailParts(text, number, known)?.runs.map((run) => [run.owners.join('+') || '-', run.text.replace(/\s+/g, ' ').trim()]).filter(([, value]) => value)
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

test('an order number written another way counts when it matches one known order; one that matches none ends the part', () => {
  const known = [A, B, C]
  // PO 202611-0013, PO-202611-13, PO 13, order no. 13, 订单号 0013, 0013 and full width.
  for (const written of ['PO 202611-0013', 'PO-202611-13', 'PO 13', 'order no. 13', '订单号 0013', '0013', 'ＰＯ２０２６１１－００１３']) {
    assert.deepEqual(orderNumbersNamed(`${A}: brackets ship on 4 December.\n${written}: hinges ship on 9 December.`, A, known), [A, B], written)
    assert.deepEqual(runsOf(`${A}: brackets ship on 4 December.\n${written}: hinges ship on 9 December.`, A, known).map(([owners]) => owners), [A, B], written)
  }
  // Not known (or known twice): the line belongs to no order, and the part ends.
  assert.deepEqual(runsOf(`${A}: brackets ship on 4 December.\nFor 0013 the hinges ship on 9 December.\nThe springs follow on 11 December.\n\n${C}: unchanged.`, A, [A, C]), [
    [A, `${A}: brackets ship on 4 December.`],
    ['-', 'For 0013 the hinges ship on 9 December. The springs follow on 11 December.'],
    [C, `${C}: unchanged.`],
  ])
  assert.deepEqual(orderNumbersNamed(`${A} and PO 13`, A, [A, B, 'PO-202610-0013']), [A])
  // Without known orders, a variant counts for nothing, and a reply naming
  // one full number stays a one-order reply.
  assert.equal(emailParts(`${A}: brackets ship on 4 December.\n0013: hinges ship on 9 December.`, A), null)
})

test('a number named further into a sentence claims that sentence only, or shares it with the order whose part it is in; an order pointed to by its place belongs to none', () => {
  // Outside any order's part (after a blank line), which order the sentence
  // is about cannot be told: no single order's, so the person decides
  // (#449 review probes W06, W07). Known cost: this one is B's own date, and
  // code cannot tell it from case 12 (A's items "with the B goods"); held
  // for the person is accepted (coordinator, 11/22).
  assert.deepEqual(runsOf(`${A}: hinges ship on 4 December.\n\nYour other order for the same items, ${B}, follows on 9 December.\nRegards`), [
    [A, `${A}: hinges ship on 4 December.`], ['-', `Your other order for the same items, ${B}, follows on 9 December. Regards`],
  ])
  // Inside another order's part, the part's heading counts as a number: the
  // sentence names two orders and belongs to both (blind batch 5, case 12),
  // and the part ends there: no part goes on past another order's number.
  // The same known cost as above for the "Your other order" sentence.
  assert.deepEqual(runsOf(`${B}: brackets ship on 9 December.\nThanks, Pat (re ${A})\nAll ship on 9 December.`), [
    [B, `${B}: brackets ship on 9 December.`], [`${A}+${B}`, `Thanks, Pat (re ${A})`], ['-', 'All ship on 9 December.'],
  ])
  assert.deepEqual(runsOf(`${A}: hinges ship on 4 December.\nYour other order for the same items, ${B}, follows on 9 December.\nRegards`), [
    [A, `${A}: hinges ship on 4 December.`], [`${A}+${B}`, `Your other order for the same items, ${B}, follows on 9 December.`], ['-', 'Regards'],
  ])
  // A sentence that starts with the number continues: "It" is that order's.
  assert.deepEqual(runsOf(`${A} ships on 1 December. ${B} is delayed. It will ship on 9 December.`), [[A, `${A} ships on 1 December.`], [B, `${B} is delayed. It will ship on 9 December.`]])
  for (const pointer of ['The brackets on the first order will slip to 5 December.', 'The other order ships on 5 December.', '第一张单的支架推迟到12月5日。', '另一张订单12月5日发货。', 'The latter ships on 5 December.']) {
    assert.deepEqual(runsOf(`${A}: brackets ship on 4 December.\n${B}: hinges ship on 9 December.\n${pointer}`).at(-1), ['-', pointer.normalize('NFKC')], pointer)
  }
})

test('a header is the number with at most one label word and a colon; a short status line is not one', () => {
  assert.deepEqual(runsOf(`${A}: on hold.\n\nThe hinges ship on 9 December.\n\n${B}: brackets ship on 4 December.`), [
    [A, `${A}: on hold.`], ['-', 'The hinges ship on 9 December.'], [B, `${B}: brackets ship on 4 December.`],
  ])
  assert.deepEqual(runsOf(`${A}：已取消。\n\n铰链12月9日发货。\n\n${B}：支架12月4日发货。`), folded([
    [A, `${A}：已取消。`], ['-', '铰链12月9日发货。'], [B, `${B}：支架12月4日发货。`],
  ]))
  // More than one label word is no header either.
  assert.deepEqual(runsOf(`Regarding purchase order ${A}:\n\nBrackets ship on 4 December.\n\n${B}: hinges ship on 9 December.`).map(([owners]) => owners), [A, '-', B])
  // One label word, or none, with a colon and nothing after it: a header.
  for (const header of [`${A}:`, `Order ${A}:`, `Re: ${A}:`, `订单 ${A}：`]) {
    assert.deepEqual(runsOf(`${header}\n\nBrackets ship on 4 December.\n\n${B}: hinges ship on 9 December.`).map(([owners]) => owners), [A, B], header)
  }
})

test('an order number written straight before a date stops at the numbering\'s length', () => {
  assert.deepEqual(orderNumbersNamed(`${A}12月4日发货，${B}延后。`, A), [A, B])
  assert.deepEqual(orderNumbersNamed(`${A}12日发货，${B}延后。`, A), [A, B])
  assert.deepEqual(orderNumbersNamed(`PO 202611-001312月4日, ${A}`, A, [A, B]), [B, A])
  // Another length is still read when it is one: PO-202611-00125.
  assert.deepEqual(orderNumbersNamed(`PO-202611-00125 and ${B}`, A, [A, B, 'PO-202611-00125']), ['PO-202611-00125', B])
  assert.deepEqual(runsOf(`${A}12月4日发货。\n${B}12月9日发货。`).map(([owners]) => owners), [A, B])
})

test('a count after an order label is no order number: 订单 7 天内, 订单3个品项, order no. 3 items (third review S07, W17, W19)', () => {
  const known = ['PO-202611-0021', 'PO-202610-0007', 'PO-202611-0003', 'PO-202611-0010']
  for (const text of ['订单 7 天内发货。', '订单3个品项都在12月9日发货。', '订单10天内全部发出：', 'Order no. 3 items ship on 9 December.', 'order #10 pcs follow']) {
    assert.deepEqual(orderNumbersNamed(`PO-202611-0021：\n${text}`, 'PO-202611-0021', known), ['PO-202611-0021'], text)
  }
  // A number that is an order's still is.
  assert.deepEqual(orderNumbersNamed('PO-202611-0021：\n订单 0003：12月9日发货。', 'PO-202611-0021', known), ['PO-202611-0021', 'PO-202611-0003'])
})

test('a unit after an order label is matched as a whole word: 天津, 个别, 件数 and 周四 are not counts (fourth review U01–U04); singulars and 周 are (fifth review)', () => {
  const A = 'PO-202611-0021'
  const B = 'PO-202611-0014'
  for (const text of ['订单 0014 件数如下：', '订单0014个别品项延迟：', '订单 0014 天津仓发货：', '订单0014周四发货：', '订单0014周日发货：', '订单 0014 周末发货：']) {
    assert.deepEqual(orderNumbersNamed(`${A}：\n${text}`, A, [A, B]), [A, B], text)
  }
  for (const text of ['订单 14 天内发货。', '订单 14 天后发货。', '订单14个品项。', '订单 14 件。', '订单 14 箱。', '订单 14 日内发货。', '订单 14 周内发货。', 'Order no. 14 days late.', 'order no. 14 weeks']) {
    assert.deepEqual(orderNumbersNamed(`${A}：\n${text}`, A, [A, B]), [A], text)
  }
  // With orders 1 and 2 on the supplier's list, a count is still no order,
  // so the one-order email is not split (and no card goes on order 1 or 2).
  const list = [B, 'PO-202611-0001', 'PO-202611-0002', 'PO-202611-0003']
  for (const text of [`${B}: order no. 1 item ships on 9 Dec.`, `${B}: order no. 2 weeks late, ships on 9 Dec.`, `${B}: order no. 2 week delay, ships on 9 Dec.`, `${B}: order no. 1 day late.`, `${B}: order no. 1 piece left.`, `${B}: order no. 1 unit missing.`, `${B}：订单 2 周内发货。`, `${B}：订单3个品项12月9日发货。`]) {
    assert.deepEqual(orderNumbersNamed(text, B, list), [B], text)
    assert.equal(emailParts(text, B, list), null, text)
  }
})

test('another order\'s number in a form the numbering does not see is found; this order, another document\'s number, a count or a date is not (W02-type gap)', () => {
  const on = 'PO-202611-0021'
  // Another order: the third review's one-order emails, and more of the same.
  for (const text of [
    'PO No. 202611-0014:', '订单号：202611-0014', 'PO‐202611‐0014:', 'Order No. 202611-0014:', 'PO#: 202611-0014', 'PO Number: 202611-0014',
    'P0-202611-0014', 'PO号：0014', 'PO 14 ships on 9 Dec.', 'PO202611-0014', '202611-0014: ships on 9 Dec.', 'No.202611-0014', '订单号202611-0014',
    'Invoice for PO No. 202611-0014', 'P.O. 202611-0014', 'PO-202610-0014', 'ＰＯ号：００１４',
    // The #461 review's misses: year and month apart, no separator after
    // the prefix, a 1–2 digit sequence after the prefix, P.O., P/O, POs, an
    // HTML space, markdown.
    'PO-2026-11-0014', 'PO 2026/11/0014', 'PO 2026 11 0014', '2026-11-0014:', 'PO2026110014', 'PO 2026110014', 'PO 202611-14', 'PO-202611-14',
    'P.O. 14', 'P/O 14', 'P.O. #14', 'POs 21 & 14', 'POs 0021, 0014', '<b>PO&nbsp;14</b>', 'PO&nbsp;202611-0014', '_PO 14_', '_PO 202611-14_',
    '(PO 202611-0014)', '**PO 202611 0014**', 'PO 14:',
  ]) assert.ok(otherOrderNumberWritten(text, on), text)
  // Not another order.
  for (const text of [
    // This order, written any of these ways.
    'PO-202611-0021', 'PO No. 202611-0021', 'PO 21', 'P0-202611-0021', '订单号：202611-0021', 'PO号：0021',
    // Another document's number: glued to its code, or labelled as it.
    'INV-202611-0014', 'SO202611-0014', 'Invoice No. 202611-0014', '发票号 202611-0014', 'PO-202611-0021 invoice no. 202611-0014', 'Tracking 1Z202611-0014',
    // A count, a date, a box, an address, the supplier's own number.
    'PO 3 items', 'PO 12月5日', 'P.O. Box 1234', 'P.O. 834, Lombard, IL 60148-0834', 'ships on 2026-11-28', '20261128', 'PO 202611', 'our ref 4471', '订单3天后发货',
    'http://p04.com/t.d?OEQjfmY', 'insync-online.p04.com', 'mail po14@example.com', 'HOUSEHOLD_2_074 ships on 3 December.', 'Please call +44 20 7946 0958',
    // This order in the forms the review added.
    'PO 202611-21', 'PO 2026-11-0021', 'PO 2026/11/0021', 'PO2026110021', 'P/O 21', 'POs 21', '<b>PO&nbsp;21</b>',
    // The review's false alarms: a number word with 单号 is another
    // document's (送货单号…), more document words, the supplier's own order.
    '送货单号：202611-0102', '发货单号 202611-0102', '运单号 202611-0102', '物流单号 202611-0102', '提单号 202611-0102', '报价单号 202611-0007',
    '生产单号 202611-0007', '批号 202611-0007', '装箱单 202611-0102', '出货单 202611-0102', '我司销售单 202611-0033', '我方订单号 202611-0033',
    'Delivery 202611-0102 attached.', 'Packing list 202611-0102', 'PL 202611-0102', 'PI 202611-0007', 'Proforma 202611-0007', 'Lot 202611-0007', 'Batch no. 202611-0007',
    'Job 202611-0007', 'RMA 202611-0007 closed.', 'ASN 202611-0007 sent.', 'Container 202611-0007', 'Credit note 202611-0007', 'CN 202611-0007', 'Certificate 202611-0007',
    'COA 202611-0007', 'Drawing 201905-001 rev B.', 'P/N 201905-001', 'Part 202011-0045', 'Sales order 202611-0033', 'Our S/O 202611-0033', 'Our SO 202611-0033',
    'Our order no. 202611-0033 refers.',
    // After a short number: a share, an amount, an ordinal, a month, more
    // units and measure words; a year; a part code.
    'PO 30% deposit received.', 'PO 1,200 pcs.', 'Your PO: 500 sets.', 'PO 2nd shipment.', 'PO 1st batch.', 'PO 18 Nov received.', 'PO 1 of 2.', 'PO 2 shipments.',
    'PO 5000 USD.', 'PO 20 rolls.', 'PO 10 kg.', 'PO 4 pairs.', 'PO 3款产品均已备好。', 'PO 2柜。', 'PO 5托。', 'PO 3批出货。', 'PO 20卷。', 'PO 2026 pricing holds.', 'PO14-B bracket in stock.',
    // Dates, phones, prices.
    'PO 2026-11-14 received.', 'Revised ETD 2026-11-14.', 'Sent 2026-11-18 10:30.', 'Shanghai 201203 021-5080 1234', 'Total USD 202611.500.', 'Tel 021-2026 1100.',
  ]) assert.equal(otherOrderNumberWritten(text, on), null, text)
  // Only for a number in the numbering format.
  assert.equal(otherOrderNumberWritten('PO No. 202611-0014', 'ACME-17'), null)
})

test('an order named by its sequence alone counts only when the supplier has another open order with that sequence (after #461\'s review)', () => {
  const on = 'PO-202611-0021'
  const OPEN = ['issued', 'partially_received']
  const open = (...numbers) => numbers.map((number) => ({ number, status: 'issued' }))
  const supplier = [...open(on, 'PO-202611-0001', 'PO-202611-0003', 'PO-202611-0014', 'PO-202611-0030', 'PO-202611-0200', 'PO-202611-1200'), { number: 'PO-202610-0014', status: 'received' }]
  // The review's misses that name the other order by its sequence.
  for (const text of ['Order 14:', 'order #14:', 'Order No. 14:', 'Order 0014:', 'your order 0014:', 'Purchase order 14:', 'Purchase Order No. 0014:', '订单14：', '订单号14：', '订单 0014：', '第14号单：', '14号单：', '采购单14：',
    '#14:', '#0014:', 'No. 14:', 'No. 0014:', '(#14)', '2026110014:', `${on}/0014:`, `${on} and -0014:`, `${on} also /0014:`, 'Order 0003:', '#003:']) {
    assert.ok(orderSequenceMentions(text).length, `mention: ${text}`)
    assert.ok(knownOrderSequenceWritten(text, on, supplier, OPEN), text)
  }
  // Not an order of ours by its sequence: the coordinator's counter-examples
  // (the supplier has open orders 1, 3, 14, 30, 200 and 1200), more counts,
  // ranks, item and document numbers, other kinds of order, the supplier's
  // own order, a number on the next line, and the Enron pilot's shapes.
  for (const text of ['PO 30% deposit received.', '#1 priority for us.', 'Item #3 is the same as last time.', '订单 14 件已备好。', 'Your PO: 1,200 pcs.',
    'Order 1 of 2 shipped.', 'Order 14 pcs packed.', 'An order of 14 units.', 'Please order 30 days ahead.', 'Order 14 Nov received.', 'order 14/11', 'Order 2026 pricing holds.', '订单14天内发出。', '订单3款产品均已备好。', '订单 30% 定金已收。',
    'Our order 14 refers.', 'Sales order 14 refers.', '我方订单14。', 'Change Order #14, Rev 6', 'Work order 14 closed.', 'Back order 14.',
    'Item No. 14:', 'Line #3: same as before.', 'Ticket #14 closed.', 'We are your #1 supplier.', '#30 bolts in stock.', 'Size #14 in stock.', '12月14号单独发货。', '1号楼3号门。',
    'Order #1: (Order #105-4008195-1643924)', 'Order #3', 'No. 1:', 'order:\n\n14', 'orders.\n\n30', 'Tel 2026110014.', 'Invoice 2026110014 attached.', `${on}, 1,200 pcs`]) {
    assert.equal(knownOrderSequenceWritten(text, on, supplier, OPEN), null, text)
  }
  // Only an open order of the supplier's other than this one counts; this
  // order's own sequence counts when another month's open order has it too.
  assert.equal(knownOrderSequenceWritten('Order 14:', on, [{ number: 'PO-202611-0014', status: 'received' }], OPEN), null)
  assert.equal(knownOrderSequenceWritten('Order 14:', on, open('PO-202611-0015'), OPEN), null)
  assert.equal(knownOrderSequenceWritten('Order 14:', on, open('INV-202611-0014'), OPEN), null)
  assert.equal(knownOrderSequenceWritten('Order 14:', on, [], OPEN), null)
  assert.equal(knownOrderSequenceWritten('Order 14:', on, null, OPEN), null)
  assert.equal(knownOrderSequenceWritten('Order 21:', on, open(on), OPEN), null)
  assert.equal(knownOrderSequenceWritten('Order 21:', on, open(on, 'PO-202610-0021'), OPEN), 'Order 21')
  assert.ok(knownOrderSequenceWritten('Order 14:', on, open('PO-202609-0014'), OPEN))
  // The whole number counts only as that exact order.
  assert.equal(knownOrderSequenceWritten('2026110014:', on, open('PO-202610-0014'), OPEN), null)
  // A long run of list marks or quote marks before a number is quick.
  const started = Date.now()
  orderSequenceMentions(`${'-'.repeat(20000)}x #14\n${'>'.repeat(20000)} No. 14`)
  assert.ok(Date.now() - started < 500)
})
