// Blind batch 5: one supplier email that names several purchase orders.
//
// What it holds: 12 held-out cases (7 English, 5 Chinese; 6 on the UCI
// workspace, 6 on M5). Each case is one supplier reply naming two or more
// orders, the order snapshots it is read against, and the expected reading
// per order: which orders are read, which are only listed, and per read
// order the card state, the lines proposed or sent to the person, and the
// dates that must never be proposed on it.
//
// How it was written: blind, from the several-orders reading rules given in
// the task brief and from ./orders.mjs only. The author did not see any
// earlier case batch, any eval result, the scorer, or the reader's code.
// The reply texts are synthetic supplier emails.
//
// Status: NOT run. No model, eval runner, app or database was used to write
// it. A run needs the owner's approval. Once it has been run against the
// reader, it is no longer held out for the code that run measured.
//
// Where the rules left room, the conservative reading was taken:
// - Same wording in two orders' parts (case 10): "ships on 4 December" in
//   both parts goes to the person on both orders, even though each part names
//   a different item.
// - A date in text of no single order that names an item on a read order
//   (cases 4, 6, 8): that line is needs_you. The card stays proposed when
//   another line of the same order has a date from its own part.
// - A sentence naming two orders with a whole-order date (case 3): both cards
//   are needs_you; no line is listed, since the sentence names no item.
// - A number in passing inside an order's part (case 12): that sentence
//   belongs to no single order, so the items it names (on both orders) go to
//   the person on both, and the order named only in passing is needs_you,
//   not nothing_to_record. The sentence is the part's last line, so the
//   other lines of the part are not touched by it.
// - "The first order" inside the second order's part (case 9): the date is
//   kept off both orders; no line is named for it, since the sentence names
//   no item.
// - An emailed reply with no pasted order (case 11): orders are read in the
//   order the email first names them.
// - A date from a closed or another supplier's order (cases 5, 6) is listed
//   in mustNotPropose on the read order; no needs_you line is expected for it.
// - replyKind is 'dates' on every read order of a reply that gives dates,
//   including cards that only go to the person.
// - over_limit is not covered: orders.mjs holds at most three open orders per
//   supplier.
import { ORDER_SNAPSHOTS } from './orders.mjs'

const WRITTEN_BY = 'FlowChain team, synthetic reply text'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

// A deep copy of one order snapshot; throws when the snapshot is missing.
function order(workspace, number) {
  const snapshot = ORDER_SNAPSHOTS[workspace]?.[number]
  if (!snapshot) throw new Error(`No order snapshot ${workspace} ${number} in orders.mjs`)
  return structuredClone(snapshot)
}

// The reply as written: the common indentation and the leading and trailing
// blank lines removed.
function email(raw) {
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[0].trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.match(/^[ \t]*/)[0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(cut).replace(/[ \t]+$/, ''))).join('\n')
}

const REQUIRED = ['id', 'lang', 'workspace', 'writtenBy', 'heldOut', 'about', 'covers', 'replyDate', 'today', 'source', 'pastedOn', 'orders', 'replyText', 'expected']
const REQUIRED_EXPECTED = ['read', 'notRead', 'byOrder']
const REQUIRED_BY_ORDER = ['state', 'alsoAccept', 'replyKind', 'lines', 'mustNotPropose']

// Checks one case's required fields, throws on a missing one, and freezes it.
function severalOrders(fields) {
  const name = fields?.id ?? '(no id)'
  for (const key of REQUIRED) {
    if (!(key in fields) || fields[key] === undefined) throw new Error(`Case ${name}: missing ${key}`)
  }
  if (fields.source === 'paste' && !fields.pastedOn) throw new Error(`Case ${name}: a pasted reply needs pastedOn`)
  if (fields.source === 'email' && fields.pastedOn !== null) throw new Error(`Case ${name}: an emailed reply has pastedOn null`)
  for (const key of REQUIRED_EXPECTED) {
    if (!(key in fields.expected)) throw new Error(`Case ${name}: missing expected.${key}`)
  }
  for (const [number, entry] of Object.entries(fields.expected.byOrder)) {
    for (const key of REQUIRED_BY_ORDER) {
      if (!(key in entry)) throw new Error(`Case ${name}: missing expected.byOrder['${number}'].${key}`)
    }
  }
  return deepFreeze(fields)
}

export const HELD_OUT_5_CASES = Object.freeze([
  // 1. A paragraph per order, clear dates.
  severalOrders({
    id: 'en-uci-0012-paragraph-per-order',
    lang: 'en',
    workspace: 'uci',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'Globex answers for both of its open orders, one paragraph each, with a written date per item. Each order gets only the dates from its own paragraph; the other paragraph\'s dates are never proposed on it.',
    covers: ['several-orders', 'paragraph-per-order'],
    replyDate: '2026-11-19',
    today: '2026-11-19',
    source: 'paste',
    pastedOn: 'PO-202611-0012',
    orders: [order('uci', 'PO-202611-0012'), order('uci', 'PO-202611-0018')],
    replyText: email(`
      Hi Jordan,

      Please see the updated dates for your two open orders below.

      PO-202611-0012
      The World War 2 Gliders (84077) and the Box of 24 Cocktail Parasols (84692) will ship on 27 November 2026.
      The Colour Glass T-Light Holder Hanging (84755) is delayed and will now ship on 4 December 2026.

      PO-202611-0018
      Antique Silver T-Light Glass (84946) will ship on 8 December 2026.
      Single Heart Zinc T-Light Holder (84970L) will ship on 10 December 2026.

      Kind regards,
      Priya Shah
      Globex Party Supplies
    `),
    expected: {
      read: ['PO-202611-0012', 'PO-202611-0018'],
      notRead: [],
      byOrder: {
        'PO-202611-0012': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-27', dateKind: 'stated', quoteIncludes: '27 November 2026' },
            { ref: 'L3', outcome: 'proposed', proposedDate: '2026-11-27', dateKind: 'stated', quoteIncludes: '27 November 2026' },
            { ref: 'L4', outcome: 'proposed', proposedDate: '2026-12-04', dateKind: 'stated', quoteIncludes: '4 December 2026' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-08', why: 'from the PO-202611-0018 paragraph' },
            { date: '2026-12-10', why: 'from the PO-202611-0018 paragraph' },
          ],
        },
        'PO-202611-0018': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L3', outcome: 'proposed', proposedDate: '2026-12-08', dateKind: 'stated', quoteIncludes: '8 December 2026' },
            { ref: 'L4', outcome: 'proposed', proposedDate: '2026-12-10', dateKind: 'stated', quoteIncludes: '10 December 2026' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-27', why: 'from the PO-202611-0012 paragraph' },
            { date: '2026-12-04', why: 'from the PO-202611-0012 paragraph' },
          ],
        },
      },
    },
  }),

  // 2. A line or table row per order.
  severalOrders({
    id: 'en-m5-0021-row-per-order',
    lang: 'en',
    workspace: 'm5',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'The supplier sends a table with one row per order line, the two orders\' rows mixed. Each row belongs to the order it starts with, so HOUSEHOLD_2_110 (on both orders) gets 1 December on PO-202611-0014 only, never on PO-202611-0021.',
    covers: ['several-orders', 'row-per-order'],
    replyDate: '2026-11-20',
    today: '2026-11-20',
    source: 'paste',
    pastedOn: 'PO-202611-0021',
    orders: [order('m5', 'PO-202611-0021'), order('m5', 'PO-202611-0014')],
    replyText: email(`
      Hello,

      Our revised ship dates, one row per order line:

      PO             | SKU             | Qty | Ship date
      PO-202611-0014 | HOUSEHOLD_2_044 | 21  | 2026-11-27
      PO-202611-0021 | HOUSEHOLD_2_074 | 22  | 2026-12-03
      PO-202611-0014 | HOUSEHOLD_2_110 | 21  | 2026-12-01
      PO-202611-0021 | HOUSEHOLD_2_185 | 20  | 2026-12-07

      Regards,
      Sam Okafor
      Household supply desk
    `),
    expected: {
      read: ['PO-202611-0021', 'PO-202611-0014'],
      notRead: [],
      byOrder: {
        'PO-202611-0021': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-03', dateKind: 'stated', quoteIncludes: '2026-12-03' },
            { ref: 'L6', outcome: 'proposed', proposedDate: '2026-12-07', dateKind: 'stated', quoteIncludes: '2026-12-07' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-01', ref: 'L2', why: 'the HOUSEHOLD_2_110 row starts with PO-202611-0014; the item is on both orders' },
            { date: '2026-11-27', why: 'from a PO-202611-0014 row' },
          ],
        },
        'PO-202611-0014': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-27', dateKind: 'stated', quoteIncludes: '2026-11-27' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-12-01', dateKind: 'stated', quoteIncludes: '2026-12-01' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-03', why: 'from a PO-202611-0021 row' },
            { date: '2026-12-07', why: 'from a PO-202611-0021 row' },
          ],
        },
      },
    },
  }),

  // 3. One sentence names two orders and gives one date: both to the person.
  severalOrders({
    id: 'zh-m5-0012-one-sentence-two-orders',
    lang: 'zh',
    workspace: 'm5',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'One Chinese sentence names both open Hobbies 2 orders and says both ship on 4 December. A date in a sentence that names two orders belongs to neither: both cards go to the person and 4 December is proposed on neither.',
    covers: ['several-orders', 'one-sentence-two-orders'],
    replyDate: '2026-11-20',
    today: '2026-11-20',
    source: 'paste',
    pastedOn: 'PO-202611-0012',
    orders: [order('m5', 'PO-202611-0012'), order('m5', 'PO-202611-0019')],
    replyText: email(`
      您好，

      关于 PO-202611-0012 和 PO-202611-0019，两张单的货都会在12月4日发出。

      祝好
      陈静
    `),
    expected: {
      read: ['PO-202611-0012', 'PO-202611-0019'],
      notRead: [],
      byOrder: {
        'PO-202611-0012': {
          state: 'needs_you',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', why: 'the sentence names PO-202611-0012 and PO-202611-0019; it belongs to neither' },
          ],
        },
        'PO-202611-0019': {
          state: 'needs_you',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', why: 'the sentence names PO-202611-0012 and PO-202611-0019; it belongs to neither' },
          ],
        },
      },
    },
  }),

  // 4. A general date in the greeting beside per-order dates.
  severalOrders({
    id: 'en-uci-0020-general-date-in-greeting',
    lang: 'en',
    workspace: 'uci',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'The greeting says the Wrap English Rose (only on PO-202611-0013) goes out on 1 December, before any order number; then each order has its own lines. The greeting\'s date goes to the person on PO-202611-0013 L1 and is proposed nowhere; the per-order dates are proposed.',
    covers: ['several-orders', 'general-date-outside-parts'],
    replyDate: '2026-11-20',
    today: '2026-11-20',
    source: 'paste',
    pastedOn: 'PO-202611-0020',
    orders: [order('uci', 'PO-202611-0020'), order('uci', 'PO-202611-0013')],
    replyText: email(`
      Hi Jordan,

      Quick update before the weekend: the Wrap English Rose (16161P) is back in stock and goes out on 1 December.

      PO-202611-0013:
      Brocade Ring Purse (17003) ships on 25 November.
      Chilli Lights (79321) ships on 26 November.

      PO-202611-0020:
      Hot Baths Metal Sign (82583) ships on 3 December.

      Thanks,
      Tom Reyes
    `),
    expected: {
      read: ['PO-202611-0020', 'PO-202611-0013'],
      notRead: [],
      byOrder: {
        'PO-202611-0020': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-12-03', dateKind: 'stated', quoteIncludes: 'ships on 3 December' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-01', why: 'the greeting, before the first order number, belongs to no single order' },
            { date: '2026-11-25', why: 'from the PO-202611-0013 part' },
            { date: '2026-11-26', why: 'from the PO-202611-0013 part' },
          ],
        },
        'PO-202611-0013': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-11-25', dateKind: 'stated', quoteIncludes: 'ships on 25 November' },
            { ref: 'L4', outcome: 'proposed', proposedDate: '2026-11-26', dateKind: 'stated', quoteIncludes: 'ships on 26 November' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-01', ref: 'L1', why: 'the greeting, before the first order number, belongs to no single order' },
            { date: '2026-12-03', why: 'from the PO-202611-0020 part' },
          ],
        },
      },
    },
  }),

  // 5. A closed order beside an open one.
  severalOrders({
    id: 'zh-uci-0030-closed-order-beside-open',
    lang: 'zh',
    workspace: 'uci',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'Acme gives a date for the rest of PO-202610-0028, which is closed in FlowChain, and another for PO-202610-0030; both are for item 85123A. Only PO-202610-0030 is read and gets 2 December; the closed order is listed, and its 27 November is never proposed on PO-202610-0030.',
    covers: ['several-orders', 'closed-order-listed'],
    replyDate: '2026-11-19',
    today: '2026-11-19',
    source: 'paste',
    pastedOn: 'PO-202610-0030',
    orders: [order('uci', 'PO-202610-0030'), { ...order('uci', 'PO-202610-0028'), status: 'closed' }],
    replyText: email(`
      您好，

      PO-202610-0028：
      剩下的 220 个 85123A White Hanging Heart T-Light Holder 11月27日补发。

      PO-202610-0030：
      330 个 85123A White Hanging Heart T-Light Holder 12月2日发货。

      谢谢！
      赵敏
    `),
    expected: {
      read: ['PO-202610-0030'],
      notRead: [{ number: 'PO-202610-0028', why: 'closed' }],
      byOrder: {
        'PO-202610-0030': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-02', dateKind: 'stated', quoteIncludes: '12月2日发货' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-27', ref: 'L1', why: 'from the part of PO-202610-0028, a closed order, for the same item 85123A' },
          ],
        },
      },
    },
  }),

  // 6. Another supplier's order named by mistake, plus an unknown number.
  severalOrders({
    id: 'en-m5-0019-other-supplier-and-unknown-number',
    lang: 'en',
    workspace: 'm5',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'The Hobbies 2 vendor gives dates under PO-202611-0019, under PO-202611-0014 (a Household 2 order, named by mistake) and under PO-202611-0027 (no such order). Only PO-202611-0019 is read: its own lines are proposed; HOBBIES_2_059, dated under the unknown number, goes to the person; the other two parts\' dates are never proposed.',
    covers: ['several-orders', 'other-supplier-and-unknown-number'],
    replyDate: '2026-11-23',
    today: '2026-11-23',
    source: 'paste',
    pastedOn: 'PO-202611-0019',
    orders: [order('m5', 'PO-202611-0019'), order('m5', 'PO-202611-0014')],
    replyText: email(`
      Hi Alex,

      Here are the dates you asked for.

      PO-202611-0019
      HOBBIES_2_018 and HOBBIES_2_026 ship on 2 December.

      PO-202611-0014
      HOBBIES_2_033 ships on 28 November.

      PO-202611-0027
      HOBBIES_2_059 ships on 5 December.

      Regards,
      Dana
    `),
    expected: {
      read: ['PO-202611-0019'],
      notRead: [
        { number: 'PO-202611-0014', why: 'other_supplier' },
        { number: 'PO-202611-0027', why: 'unknown' },
      ],
      byOrder: {
        'PO-202611-0019': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-02', dateKind: 'stated', quoteIncludes: 'ship on 2 December' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-12-02', dateKind: 'stated', quoteIncludes: 'ship on 2 December' },
            { ref: 'L6', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-28', why: 'from the part of PO-202611-0014, another supplier\'s order' },
            { date: '2026-12-05', ref: 'L6', why: 'under PO-202611-0027, a number that matches no order: text of no single order' },
          ],
        },
      },
    },
  }),

  // 7. An order number written another way.
  severalOrders({
    id: 'zh-uci-0018-number-written-another-way',
    lang: 'zh',
    workspace: 'uci',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'Pasted on PO-202611-0018, the reply heads the second paragraph "订单号 0012", which matches only PO-202611-0012 among Globex\'s orders. Both orders are read, each with the dates from its own paragraph.',
    covers: ['several-orders', 'number-written-another-way'],
    replyDate: '2026-11-20',
    today: '2026-11-20',
    source: 'paste',
    pastedOn: 'PO-202611-0018',
    orders: [order('uci', 'PO-202611-0018'), order('uci', 'PO-202611-0012')],
    replyText: email(`
      您好，

      两张单的最新交期如下。

      PO-202611-0018：
      84946 Antique Silver T-Light Glass 12月3日发货。
      84970L Single Heart Zinc T-Light Holder 12月3日发货。

      订单号 0012：
      84077 World War 2 Gliders 11月27日发货。
      84755 Colour Glass T-Light Holder Hanging 12月1日发货。

      谢谢
      刘洋
    `),
    expected: {
      read: ['PO-202611-0018', 'PO-202611-0012'],
      notRead: [],
      byOrder: {
        'PO-202611-0018': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L3', outcome: 'proposed', proposedDate: '2026-12-03', dateKind: 'stated', quoteIncludes: '12月3日发货' },
            { ref: 'L4', outcome: 'proposed', proposedDate: '2026-12-03', dateKind: 'stated', quoteIncludes: '12月3日发货' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-27', why: 'from the 订单号 0012 (PO-202611-0012) part' },
            { date: '2026-12-01', why: 'from the 订单号 0012 (PO-202611-0012) part' },
          ],
        },
        'PO-202611-0012': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-27', dateKind: 'stated', quoteIncludes: '11月27日发货' },
            { ref: 'L4', outcome: 'proposed', proposedDate: '2026-12-01', dateKind: 'stated', quoteIncludes: '12月1日发货' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-03', why: 'from the PO-202611-0018 part' },
          ],
        },
      },
    },
  }),

  // 8. A status line, a blank line, then a paragraph with no number.
  severalOrders({
    id: 'en-m5-0014-status-line-then-blank-line',
    lang: 'en',
    workspace: 'm5',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: '"PO-202611-0021: on hold." is a statement, not a header, so the blank line after it ends that part; the next paragraph dates HOUSEHOLD_2_499 (a PO-202611-0021 line) without a number. That date belongs to no single order and goes to the person; PO-202611-0014 gets its own 27 November.',
    covers: ['several-orders', 'status-line-then-blank-line'],
    replyDate: '2026-11-24',
    today: '2026-11-24',
    source: 'paste',
    pastedOn: 'PO-202611-0014',
    orders: [order('m5', 'PO-202611-0014'), order('m5', 'PO-202611-0021')],
    replyText: email(`
      Hi Chris,

      PO-202611-0014: HOUSEHOLD_2_044 and HOUSEHOLD_2_170 will ship on 27 November.

      PO-202611-0021: on hold.

      The HOUSEHOLD_2_499 cartons will ship on 4 December.

      Best regards,
      Morgan Lee
    `),
    expected: {
      read: ['PO-202611-0014', 'PO-202611-0021'],
      notRead: [],
      byOrder: {
        'PO-202611-0014': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-27', dateKind: 'stated', quoteIncludes: 'ship on 27 November' },
            { ref: 'L4', outcome: 'proposed', proposedDate: '2026-11-27', dateKind: 'stated', quoteIncludes: 'ship on 27 November' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', why: 'the paragraph after "PO-202611-0021: on hold." and a blank line belongs to no single order' },
          ],
        },
        'PO-202611-0021': {
          state: 'needs_you',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L15', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', ref: 'L15', why: '"on hold." is a statement, not a header: the blank line ends the part, so the paragraph below belongs to no single order' },
            { date: '2026-11-27', why: 'from the PO-202611-0014 part' },
          ],
        },
      },
    },
  }),

  // 9. A closing sentence that points to 第一张单 with a date.
  severalOrders({
    id: 'zh-uci-0014-closing-points-to-first-order',
    lang: 'zh',
    workspace: 'uci',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'Each order has its own paragraph of dates, but the last line of the PO-202611-0014 paragraph says the rest of 第一张单 (the first order) ships on 5 December. A sentence that points to an order by its place belongs to no single order: 5 December is proposed on neither order.',
    covers: ['several-orders', 'points-by-place'],
    replyDate: '2026-11-19',
    today: '2026-11-19',
    source: 'paste',
    pastedOn: 'PO-202611-0014',
    orders: [order('uci', 'PO-202611-0014'), order('uci', 'PO-202611-0008')],
    replyText: email(`
      您好，

      PO-202611-0008：
      20724 Red Retrospot Charlotte Bag、20727 Lunch Bag Black Skull 11月26日发货。

      PO-202611-0014：
      20668 Disco Ball Christmas Decoration 12月2日发货。
      20914 Set/5 Red Retrospot Lid Glass Bowls 12月3日发货。
      第一张单剩下的货也在12月5日一起发。

      谢谢！
      周凯
    `),
    expected: {
      read: ['PO-202611-0014', 'PO-202611-0008'],
      notRead: [],
      byOrder: {
        'PO-202611-0014': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-02', dateKind: 'stated', quoteIncludes: '12月2日发货' },
            { ref: 'L3', outcome: 'proposed', proposedDate: '2026-12-03', dateKind: 'stated', quoteIncludes: '12月3日发货' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-05', why: 'the sentence points to 第一张单 by its place: it belongs to no single order, though it sits in this part' },
            { date: '2026-11-26', why: 'from the PO-202611-0008 part' },
          ],
        },
        'PO-202611-0008': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-26', dateKind: 'stated', quoteIncludes: '11月26日发货' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-11-26', dateKind: 'stated', quoteIncludes: '11月26日发货' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-05', why: 'the sentence points to 第一张单 by its place, not by number: it belongs to no single order' },
            { date: '2026-12-02', why: 'from the PO-202611-0014 part' },
            { date: '2026-12-03', why: 'from the PO-202611-0014 part' },
          ],
        },
      },
    },
  }),

  // 10. The same wording in two orders' parts, about different items.
  severalOrders({
    id: 'en-m5-0019-same-wording-two-parts',
    lang: 'en',
    workspace: 'm5',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: '"ships on 4 December" appears in both orders\' parts, for different items. A date whose exact wording appears in two orders\' parts goes to the person on both; the other dates, each worded once, are proposed.',
    covers: ['several-orders', 'same-wording-two-parts'],
    replyDate: '2026-11-23',
    today: '2026-11-23',
    source: 'paste',
    pastedOn: 'PO-202611-0019',
    orders: [order('m5', 'PO-202611-0019'), order('m5', 'PO-202611-0012')],
    replyText: email(`
      Hi Robin,

      PO-202611-0012
      - HOBBIES_2_007: ships on 4 December
      - HOBBIES_2_024: ships on 1 December

      PO-202611-0019
      - HOBBIES_2_018: ships on 4 December
      - HOBBIES_2_026: ships on 7 December

      Thanks,
      Kim
    `),
    expected: {
      read: ['PO-202611-0019', 'PO-202611-0012'],
      notRead: [],
      byOrder: {
        'PO-202611-0019': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-12-07', dateKind: 'stated', quoteIncludes: 'ships on 7 December' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', ref: 'L1', why: '"ships on 4 December" is worded the same in both orders\' parts' },
            { date: '2026-12-01', why: 'from the PO-202611-0012 part' },
          ],
        },
        'PO-202611-0012': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-12-01', dateKind: 'stated', quoteIncludes: 'ships on 1 December' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', ref: 'L1', why: '"ships on 4 December" is worded the same in both orders\' parts' },
            { date: '2026-12-07', why: 'from the PO-202611-0019 part' },
          ],
        },
      },
    },
  }),

  // 11. An emailed reply naming three orders.
  severalOrders({
    id: 'en-uci-0028-emailed-three-orders',
    lang: 'en',
    workspace: 'uci',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'An emailed reply (not pasted on an order) gives dates for all three open Acme orders, one paragraph each. All three are read in the order named; 85123A is on two of them, and each gets only the date its own paragraph states.',
    covers: ['several-orders', 'emailed-three-orders'],
    replyDate: '2026-11-18',
    today: '2026-11-18',
    source: 'email',
    pastedOn: null,
    orders: [order('uci', 'PO-202610-0028'), order('uci', 'PO-202610-0030'), order('uci', 'PO-202611-0019')],
    replyText: email(`
      Hello,

      Please find our delivery update for your open orders.

      PO-202610-0028 - the balance of 220 White Hanging Heart T-Light Holders (85123A) will ship on 25 November.

      PO-202610-0030 - all 330 White Hanging Heart T-Light Holders (85123A) will ship on 2 December.

      PO-202611-0019 - Jumbo Bag Baroque Black White (85099C) will ship on 4 December; Hand Over The Chocolate Sign (85152) will follow on 9 December.

      Kind regards,
      Customer Service
      Acme Home Goods
    `),
    expected: {
      read: ['PO-202610-0028', 'PO-202610-0030', 'PO-202611-0019'],
      notRead: [],
      byOrder: {
        'PO-202610-0028': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-25', dateKind: 'stated', quoteIncludes: 'ship on 25 November' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-02', ref: 'L1', why: 'from the PO-202610-0030 paragraph, for the same item 85123A' },
            { date: '2026-12-04', why: 'from the PO-202611-0019 paragraph' },
            { date: '2026-12-09', why: 'from the PO-202611-0019 paragraph' },
          ],
        },
        'PO-202610-0030': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-02', dateKind: 'stated', quoteIncludes: 'ship on 2 December' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-25', ref: 'L1', why: 'from the PO-202610-0028 paragraph, for the same item 85123A' },
            { date: '2026-12-04', why: 'from the PO-202611-0019 paragraph' },
            { date: '2026-12-09', why: 'from the PO-202611-0019 paragraph' },
          ],
        },
        'PO-202611-0019': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-12-04', dateKind: 'stated', quoteIncludes: 'ship on 4 December' },
            { ref: 'L2', outcome: 'proposed', proposedDate: '2026-12-09', dateKind: 'stated', quoteIncludes: 'follow on 9 December' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-25', why: 'from the PO-202610-0028 paragraph' },
            { date: '2026-12-02', why: 'from the PO-202610-0030 paragraph' },
          ],
        },
      },
    },
  }),

  // 12. Own choice, in Chinese: an order named in passing inside another
  // order's part, for items on both orders, beside a relative date.
  severalOrders({
    id: 'zh-m5-0021-passing-mention-shared-items',
    lang: 'zh',
    workspace: 'm5',
    writtenBy: WRITTEN_BY,
    heldOut: true,
    about: 'Under PO-202611-0021 the supplier gives 后天 and 12月3日 for two lines, then says HOUSEHOLD_2_110 and HOUSEHOLD_2_437 (on both orders) ship on 12月8日 together with PO-202611-0014\'s goods, naming that order only in passing. That sentence belongs to no single order: 8 December goes to the person on both orders; 后天 is read as 20 November from the reply date.',
    covers: ['several-orders', 'passing-mention-shared-items'],
    replyDate: '2026-11-18',
    today: '2026-11-18',
    source: 'paste',
    pastedOn: 'PO-202611-0021',
    orders: [order('m5', 'PO-202611-0021'), order('m5', 'PO-202611-0014')],
    replyText: email(`
      张经理您好，

      PO-202611-0021 的交期更新如下：
      HOUSEHOLD_2_074 后天发货。
      HOUSEHOLD_2_239 12月3日发货。
      HOUSEHOLD_2_110 和 HOUSEHOLD_2_437 会跟 PO-202611-0014 的货一起在12月8日发出。

      有问题随时联系。
      李娜
    `),
    expected: {
      read: ['PO-202611-0021', 'PO-202611-0014'],
      notRead: [],
      byOrder: {
        'PO-202611-0021': {
          state: 'proposed',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L1', outcome: 'proposed', proposedDate: '2026-11-20', dateKind: 'relative', quoteIncludes: '后天发货', readAs: { phrase: '后天', from: '2026-11-18', date: '2026-11-20' } },
            { ref: 'L7', outcome: 'proposed', proposedDate: '2026-12-03', dateKind: 'stated', quoteIncludes: '12月3日发货' },
            { ref: 'L2', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
            { ref: 'L11', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-08', ref: 'L2', why: 'the sentence names PO-202611-0014 in passing, so it belongs to no single order; HOUSEHOLD_2_110 is on both orders' },
            { date: '2026-12-08', ref: 'L11', why: 'the sentence names PO-202611-0014 in passing, so it belongs to no single order; HOUSEHOLD_2_437 is on both orders' },
          ],
        },
        'PO-202611-0014': {
          state: 'needs_you',
          alsoAccept: [],
          replyKind: 'dates',
          lines: [
            { ref: 'L2', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
            { ref: 'L10', outcome: 'needs_you', proposedDate: null, dateKind: 'stated' },
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-08', why: 'PO-202611-0014 is named only in passing inside the PO-202611-0021 part; the sentence belongs to no single order' },
            { date: '2026-11-20', why: 'from the PO-202611-0021 part (后天)' },
            { date: '2026-12-03', why: 'from the PO-202611-0021 part' },
          ],
        },
      },
    },
  }),
])
